/**
 * src/history/etherscan.js
 *
 * Etherscan V2 multichain client for transaction history.
 * Single shared rate-limit gate — without an API key the public endpoint
 * throttles around 5 req/s, so we keep a 200ms minimum gap between requests.
 */

const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api';

const CHAIN_IDS = {
  ethereum: 1,
  polygon:  137,
  arbitrum: 42161,
  base:     8453,
  optimism: 10,
};

const PAGE_SIZE = 10000;
const MAX_ROWS_PER_ACTION = 10000;

const MIN_REQUEST_GAP_MS = 200;
// Chained-promise queue so concurrent callers serialize through the gate instead of all firing at once.
let _gateChain = Promise.resolve();
let _lastRequestAt = 0;
function rateLimitGate() {
  const next = _gateChain.then(async () => {
    const wait = _lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastRequestAt = Date.now();
  });
  _gateChain = next.catch(() => {});
  return next;
}

function chainIdFor(chain) {
  const id = CHAIN_IDS[chain];
  if (id === undefined) throw new Error(`Unsupported chain: ${chain}`);
  return id;
}

function buildUrl(chainId, params, apiKey) {
  const qs = new URLSearchParams({ chainid: String(chainId), ...params });
  if (apiKey) qs.set('apikey', apiKey);
  return `${ETHERSCAN_BASE}?${qs.toString()}`;
}

async function getJson(url, signal) {
  await rateLimitGate();
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Get the block number closest to a unix timestamp.
 * @param {string} chain
 * @param {number} unixSec
 * @param {'before'|'after'} closest
 * @param {{ apiKey?: string, signal?: AbortSignal, onWarn?: (m: string) => void }} [opts]
 * @returns {Promise<number|null>} block number, or null on error
 */
export async function blockNumberAtTimestamp(chain, unixSec, closest, opts = {}) {
  const url = buildUrl(chainIdFor(chain), {
    module:    'block',
    action:    'getblocknobytime',
    timestamp: Math.floor(unixSec),
    closest,
  }, opts.apiKey);

  const data = await getJson(url, opts.signal);
  if (!data) {
    opts.onWarn?.(`etherscan: getblocknobytime network error (${chain}, ts=${unixSec})`);
    return null;
  }
  if (data.status !== '1') {
    opts.onWarn?.(`etherscan: getblocknobytime status=0 message=${data.message ?? 'unknown'}`);
    return null;
  }
  const n = parseInt(data.result, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a [fromTs, toTs] pair to [startBlock, endBlock] for use in txlist queries.
 * @param {string} chain
 * @param {number} fromTs
 * @param {number} toTs
 * @param {{ apiKey?: string, signal?: AbortSignal, onWarn?: (m: string) => void }} [opts]
 * @returns {Promise<{ startBlock: number|null, endBlock: number|null, error: string|null }>}
 */
export async function resolveBlockRange(chain, fromTs, toTs, opts = {}) {
  const [startBlock, endBlock] = await Promise.all([
    blockNumberAtTimestamp(chain, fromTs, 'after',  opts),
    blockNumberAtTimestamp(chain, toTs,   'before', opts),
  ]);
  if (startBlock === null || endBlock === null) {
    return { startBlock, endBlock, error: 'failed to resolve block range from timestamps' };
  }
  if (startBlock > endBlock) {
    return { startBlock, endBlock, error: 'empty range: startBlock > endBlock' };
  }
  return { startBlock, endBlock, error: null };
}

/**
 * Generic paginated fetch for an account-scoped Etherscan action.
 * @param {string} chain
 * @param {string} action     - 'txlist' | 'txlistinternal' | 'tokentx'
 * @param {string} address
 * @param {number} startBlock
 * @param {number} endBlock
 * @param {{ apiKey?: string, signal?: AbortSignal, onWarn?: (m: string) => void }} [opts]
 * @returns {Promise<{ rows: object[], truncated: boolean, error: string|null }>}
 */
async function fetchPaged(chain, action, address, startBlock, endBlock, opts = {}) {
  const chainId = chainIdFor(chain);
  const addrLc  = address.toLowerCase();
  const out = [];
  // Dedup keys: txlist/txlistinternal share `hash` (internals add traceId when present
  // to distinguish multiple internal calls inside one tx); tokentx uses hash+logIndex
  // (transactionIndex fallback) because one tx can emit multiple Transfer events.
  const seen = new Set();
  let page = 1;
  let truncated = false;

  while (out.length < MAX_ROWS_PER_ACTION) {
    const url = buildUrl(chainId, {
      module:     'account',
      action,
      address:    addrLc,
      startblock: startBlock,
      endblock:   endBlock,
      page,
      offset:     PAGE_SIZE,
      sort:       'asc',
    }, opts.apiKey);

    const data = await getJson(url, opts.signal);
    if (!data) return { rows: out, truncated, error: `etherscan ${action}: network error` };

    if (data.status === '0') {
      const msg = (data.message ?? '').toString();
      if (msg.toLowerCase().includes('no transactions found')) {
        return { rows: out, truncated, error: null };
      }
      return { rows: out, truncated, error: `etherscan ${action}: ${msg || 'unknown error'}` };
    }

    const result = Array.isArray(data.result) ? data.result : [];
    for (const r of result) {
      const row = normalizeRow(r, action);
      const key = dedupKey(row, action);
      if (key !== null && seen.has(key)) continue;
      if (key !== null) seen.add(key);
      out.push(row);
    }

    if (result.length < PAGE_SIZE) break;
    if (out.length >= MAX_ROWS_PER_ACTION) {
      truncated = true;
      opts.onWarn?.(`etherscan ${action}: truncated at ${MAX_ROWS_PER_ACTION} rows for ${addrLc}; narrow --from/--to to retrieve all rows`);
      break;
    }
    page += 1;
  }

  return { rows: out, truncated, error: null };
}

// Stable identity for a row within a single action's result stream.
// Returns null only if the row lacks the fields we'd key on (shouldn't happen
// for valid Etherscan responses, but we'd rather keep the row than crash).
function dedupKey(row, action) {
  if (action === 'tokentx') {
    const sub = row.logIndex ?? row.transactionIndex;
    return row.hash ? `${row.hash}:${sub ?? ''}` : null;
  }
  if (action === 'txlistinternal') {
    return row.hash ? `${row.hash}:${row.traceId ?? ''}` : null;
  }
  return row.hash ?? null;
}

// Lowercase address-like fields for consistent matching downstream;
// timeStamp coerced to integer seconds; big-number fields kept as decimal strings.
function normalizeRow(r, action) {
  const kind =
    action === 'txlist'         ? 'normal'   :
    action === 'txlistinternal' ? 'internal' :
    action === 'tokentx'        ? 'token'    : 'unknown';
  const lower = (s) => (typeof s === 'string' && s.length > 0) ? s.toLowerCase() : s;
  return {
    ...r,
    _kind:           kind,
    timeStamp:       parseInt(r.timeStamp ?? '0', 10) || 0,
    from:            lower(r.from),
    to:              lower(r.to),
    contractAddress: lower(r.contractAddress),
    hash:            lower(r.hash),
  };
}

/**
 * Fetch normal external transactions for an address, paged.
 * @param {string} chain
 * @param {string} address
 * @param {number} startBlock
 * @param {number} endBlock
 * @param {{ apiKey?: string, signal?: AbortSignal, onWarn?: (m: string) => void }} [opts]
 * @returns {Promise<{ rows: object[], truncated: boolean, error: string|null }>}
 */
export const fetchNormalTxs   = (c, a, s, e, o) => fetchPaged(c, 'txlist',         a, s, e, o);

/**
 * Fetch internal transactions (the actual native value movements during a swap).
 * @param {string} chain
 * @param {string} address
 * @param {number} startBlock
 * @param {number} endBlock
 * @param {{ apiKey?: string, signal?: AbortSignal, onWarn?: (m: string) => void }} [opts]
 * @returns {Promise<{ rows: object[], truncated: boolean, error: string|null }>}
 */
export const fetchInternalTxs = (c, a, s, e, o) => fetchPaged(c, 'txlistinternal', a, s, e, o);

/**
 * Fetch ERC20 token transfers for an address.
 * @param {string} chain
 * @param {string} address
 * @param {number} startBlock
 * @param {number} endBlock
 * @param {{ apiKey?: string, signal?: AbortSignal, onWarn?: (m: string) => void }} [opts]
 * @returns {Promise<{ rows: object[], truncated: boolean, error: string|null }>}
 */
export const fetchTokenTxs    = (c, a, s, e, o) => fetchPaged(c, 'tokentx',        a, s, e, o);
