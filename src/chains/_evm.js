/**
 * src/chains/_evm.js
 *
 * Shared utilities for EVM-compatible chains.
 * Not exported as a chain adapter — used internally.
 */

import {
  createPublicClient,
  http,
  formatUnits,
  getAddress,
  isAddress,
} from 'viem';

import { redactUrl, jsonSafeQuorumValue } from '../output/serialize.js';

// ─── Minimal ABI fragments ────────────────────────────────────────────────────

export const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
];

// ─── Token lists per chain ────────────────────────────────────────────────────

export const TOKEN_LISTS = {
  ethereum: [
    { symbol: 'USDC',   contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6  },
    { symbol: 'USDT',   contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6  },
    { symbol: 'DAI',    contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    { symbol: 'WETH',   contract: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    { symbol: 'WBTC',   contract: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8  },
    // Liquid staking tokens
    { symbol: 'stETH',  contract: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', decimals: 18 }, // Lido staked ETH
    { symbol: 'wstETH', contract: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', decimals: 18 }, // Lido wrapped stETH
    { symbol: 'rETH',   contract: '0xae78736Cd615f374D3085123A210448E74Fc6393', decimals: 18 }, // Rocket Pool ETH
    { symbol: 'cbETH',  contract: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', decimals: 18 }, // Coinbase staked ETH
    // DeFi governance & protocol tokens
    { symbol: 'AAVE',   contract: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18 }, // Aave governance
    { symbol: 'CRV',    contract: '0xD533a949740bb3306d119CC777fa900bA034cd52', decimals: 18 }, // Curve
    { symbol: 'LDO',    contract: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', decimals: 18 }, // Lido governance
    { symbol: 'MKR',    contract: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', decimals: 18 }, // Maker
    { symbol: 'SNX',    contract: '0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F', decimals: 18 }, // Synthetix
  ],
  polygon: [
    { symbol: 'USDC',   contract: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6  },
    { symbol: 'USDT',   contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6  },
    { symbol: 'WETH',   contract: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
    { symbol: 'WMATIC', contract: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18 },
  ],
  arbitrum: [
    { symbol: 'USDC',  contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6  },
    { symbol: 'USDT',  contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6  },
    { symbol: 'DAI',   contract: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    { symbol: 'WETH',  contract: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    { symbol: 'WBTC',  contract: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8  },
    { symbol: 'ARB',   contract: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
    { symbol: 'GMX',   contract: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', decimals: 18 },
  ],
  base: [
    { symbol: 'USDC',  contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6  },
    { symbol: 'DAI',   contract: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    { symbol: 'WETH',  contract: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'WELL',  contract: '0xA88594D404727625A9437C3f886C7643872296AE', decimals: 18 }, // Moonwell
  ],
  optimism: [
    { symbol: 'USDC',  contract: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6  }, // Circle-native USDC
    { symbol: 'USDC.e',contract: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', decimals: 6  }, // Bridged USDC
    { symbol: 'USDT',  contract: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6  },
    { symbol: 'DAI',   contract: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    { symbol: 'WETH',  contract: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'WBTC',  contract: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', decimals: 8  },
    { symbol: 'OP',    contract: '0x4200000000000000000000000000000000000042', decimals: 18 },
  ],
  // Linea and zkSync canonical token lists intentionally omitted until each
  // address is independently verified. With fail-closed semantics in
  // tokens/filter.js, the missing list means *no* symbol-keyed price is
  // applied on those chains, so a spoofed "USDC" cannot inherit a real price.
  // Real holdings on linea/zksync are surfaced as noPrice:true (still visible
  // via --show-unpriced). Add verified entries here to restore pricing.
};

// ─── In-memory token metadata cache ──────────────────────────────────────────
// key: `${chainId}:${contractAddress}`
const tokenMetaCache = new Map();

/**
 * Build a viem PublicClient for the given RPC URL.
 *
 * @param {string} rpcUrl
 * @param {*} chain         - viem chain object
 * @param {AbortSignal} [signal] - optional AbortSignal; when provided, viem
 *   passes it directly to the fetch call so the underlying TCP connection is
 *   torn down as soon as the signal fires.  Pairing this with keepalive:false
 *   prevents undici from recycling the socket back into its connection pool,
 *   which is what would otherwise keep the Node event loop alive after the
 *   request is logically complete.
 */
export function makeClient(rpcUrl, chain, signal) {
  const fetchOptions = signal
    ? { signal, keepalive: false }
    : { keepalive: false };
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 10_000, fetchOptions }),
  });
}

// Maximum number of balanceOf calls per multicall batch.
// Keeps individual multicall payloads within typical RPC node limits (~100-500).
const MULTICALL_CHUNK_SIZE = 100;

/**
 * Split an array into consecutive chunks of at most `size` elements.
 *
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Read ERC-20 balanceOf for a list of token descriptors.
 * Splits large token lists into chunks of MULTICALL_CHUNK_SIZE to avoid
 * "execution reverted" errors on RPC nodes that cap multicall batch size.
 * Falls back gracefully to sequential individual calls if multicall is unavailable.
 *
 * @param {ReturnType<typeof makeClient>} client
 * @param {string} address   - checksummed owner address
 * @param {{ symbol, contract, decimals }[]} tokens
 * @returns {Promise<{ symbol, amount, decimals, contract }[]>}
 */
export async function fetchERC20Balances(client, address, tokens) {
  if (tokens.length === 0) return [];

  const tokenChunks = chunkArray(tokens, MULTICALL_CHUNK_SIZE);

  // Run all chunks concurrently; each chunk is one multicall request.
  const chunkResults = await Promise.all(
    tokenChunks.map(async (chunk) => {
      const calls = chunk.map(tok => ({
        address: tok.contract,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      }));

      let results;
      try {
        results = await client.multicall({ contracts: calls, allowFailure: true });
      } catch {
        // multicall not available on this node — fall back to sequential reads
        results = await Promise.all(
          calls.map(async (c) => {
            try {
              const result = await client.readContract({
                address: c.address,
                abi: ERC20_ABI,
                functionName: 'balanceOf',
                args: c.args,
              });
              return { result, status: 'success' };
            } catch (e) {
              return { error: e, status: 'failure' };
            }
          })
        );
      }

      // Pair each result back with its token descriptor and collect non-zero balances.
      const balances = [];
      for (let i = 0; i < chunk.length; i++) {
        const res = results[i];
        if (res.status === 'success' && res.result > 0n) {
          const tok = chunk[i];
          balances.push({
            symbol:   tok.symbol,
            amount:   formatUnits(res.result, tok.decimals),
            decimals: tok.decimals,
            contract: tok.contract,
          });
        }
      }
      return balances;
    })
  );

  // Flatten results from all chunks into a single array.
  return chunkResults.flat();
}

/**
 * Fetch on-chain symbol + decimals for a contract; uses in-memory cache.
 */
export async function fetchTokenMeta(client, contractAddress, chainKey) {
  const cacheKey = `${chainKey}:${contractAddress.toLowerCase()}`;
  if (tokenMetaCache.has(cacheKey)) return tokenMetaCache.get(cacheKey);

  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: contractAddress, abi: ERC20_ABI, functionName: 'symbol' }),
      client.readContract({ address: contractAddress, abi: ERC20_ABI, functionName: 'decimals' }),
    ]);
    const meta = { symbol, decimals };
    tokenMetaCache.set(cacheKey, meta);
    return meta;
  } catch {
    return null;
  }
}

/**
 * Build the standard balance response shape.
 */
export function buildBalanceResponse(chainName, nativeSymbol, nativeAmount, nativeDecimals, tokens) {
  return {
    chain:  chainName,
    native: {
      symbol:   nativeSymbol,
      amount:   nativeAmount,
      decimals: nativeDecimals,
    },
    tokens,
    error: null,
  };
}

/**
 * Build an error response shape.
 */
export function buildErrorResponse(chainName, message) {
  return { chain: chainName, native: null, tokens: [], error: message };
}

export { formatUnits, getAddress, isAddress };

// ─── RPC Quorum Helper ────────────────────────────────────────────────────────

// Maximum number of RPC URLs queryQuorum will fan out to in parallel.
// Caps resource usage and prevents pathological caller mistakes.
export const MAX_QUORUM_FANOUT = 16;

/**
 * redactUrl + jsonSafeQuorumValue are imported from '../output/serialize.js'.
 * They are the canonical implementations; keeping local copies risks drift
 * (e.g. missing BigInt-in-object handling in error serialization).
 */

/**
 * Custom error thrown when `mode: 'all'` detects disagreement across RPCs.
 * Callers can pattern-match on this class to decide how to handle divergence.
 *
 * The `values` field is preserved as-is for programmatic inspection, but
 * `toJSON()` and the error `message` use bounded previews to avoid emitting
 * megabytes of raw payload when object-shaped values disagree.
 */
export class RpcDisagreementError extends Error {
  /**
   * @param {object} opts
   * @param {string} [opts.chain]       - Chain identifier (optional)
   * @param {string[]} opts.urls        - All queried URLs
   * @param {Array<{url:string,normalizedKey:string,value:*}>} opts.values - Per-URL results
   */
  constructor({ chain, urls, values }) {
    const previews = values.map((v) => ({
      url: redactUrl(v.url),
      normalizedKey: v.normalizedKey,
      valuePreview: jsonSafeQuorumValue(v.value),
    }));
    super(
      `RPC providers returned disagreeing values across ${urls.length} endpoints: ` +
        JSON.stringify(previews),
    );
    this.name = 'RpcDisagreementError';
    this.chain = chain ?? null;
    this.urls = urls;
    this.values = values;
  }

  toJSON() {
    return {
      chain: this.chain,
      urls: this.urls.map(redactUrl),
      valuePreviews: this.values.map((v) => ({
        url: redactUrl(v.url),
        normalizedKey: v.normalizedKey,
        valuePreview: jsonSafeQuorumValue(v.value),
      })),
    };
  }
}

/**
 * Query multiple RPC URLs in parallel with a configurable quorum policy.
 *
 * IMPORTANT: 429 (rate-limit) backoff is intentionally NOT implemented here.
 * Backoff belongs at the call-site retry layer, not in this quorum helper.
 * Providers with aggressive free-tier limits (Ankr, polygon-rpc.com,
 * mainnet.optimism.io) may need per-adapter retry wrappers around exec.
 *
 * SECURITY: mode='any' returns the FIRST successful response without
 * comparing against other providers. It trusts the fastest responder
 * and provides no defense against a fast-but-malicious RPC. For
 * balance/state data, prefer 'majority' or 'all'.
 *
 * @template T
 * @param {object} opts
 * @param {string[]}                      opts.urls       - RPC URLs to query in parallel
 * @param {*}                             opts.viemChain  - Viem chain object (e.g. mainnet)
 * @param {(client: *) => Promise<T>}     opts.exec       - Per-client work; caller controls what viem calls to make
 * @param {'any'|'majority'|'all'}        [opts.mode]     - Quorum policy. Default 'any'
 * @param {(value: T) => string|null}     [opts.normalize] - Comparator key generator. Default String(value)
 * @param {number}                        [opts.timeoutMs] - Per-URL timeout in ms. Default 10_000
 *
 * @returns {Promise<{
 *   value: T,
 *   source: string,
 *   sources: Array<{url:string, status:'fulfilled'|'rejected', value?:T, normalizedKey?:string, error?:string}>,
 *   agreement: 'unanimous'|'majority'|'plurality'|'single',
 *   disagreements: Array<{url:string, value:T, normalizedKey:string}>,
 *   mode: 'any'|'majority'|'all',
 * }>}
 *
 * @throws {RpcDisagreementError} Only when mode='all' and successful responses disagree
 * @throws {Error} When all URLs fail (any mode), when urls.length is out of range,
 *                 or when the default normalizer collapses an object to "[object Object]"
 */
export async function queryQuorum({
  urls,
  viemChain,
  exec,
  mode = 'any',
  normalize,
  timeoutMs = 10_000,
}) {
  if (urls.length > MAX_QUORUM_FANOUT || urls.length < 1) {
    throw new Error(
      `queryQuorum: urls.length must be between 1 and ${MAX_QUORUM_FANOUT}`,
    );
  }

  // Default normalizer: String() coercion handles primitives and BigInts
  const normalizer = normalize ?? ((v) => String(v));

  /**
   * Wrap a single exec(client) call with a per-URL timeout.
   *
   * An AbortController is created for each URL.  Its signal is forwarded to
   * the viem http transport (via fetchOptions) so that the underlying TCP/TLS
   * connection is immediately destroyed when we no longer need the request —
   * either because our own timeout fired, or because exec() already settled.
   * Without this, a slow or non-responding RPC leaves an in-flight undici
   * socket that pins the Node event loop for the duration of the server-side
   * TCP timeout (tens of seconds), causing the visible CLI hang.
   *
   * keepalive:false in makeClient ensures undici does not recycle the socket
   * back into its connection pool after a cancelled request, which would also
   * keep the event loop alive.
   *
   * @param {string} url
   * @returns {Promise<{url:string, status:'fulfilled'|'rejected', value?:*, normalizedKey?:string, error?:string}>}
   */
  function execWithTimeout(url) {
    const controller = new AbortController();
    const client = makeClient(url, viemChain, controller.signal);

    let timerHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timerHandle = setTimeout(
        () => reject(new Error(`timeout after ${timeoutMs}ms querying ${redactUrl(url)}`)),
        timeoutMs,
      );
    });

    return Promise.race([exec(client), timeoutPromise]).then(
      (value) => {
        clearTimeout(timerHandle);
        // Abort cancels any residual in-flight sub-requests (e.g. multicall
        // chunks that resolved after the race winner) and releases the socket.
        controller.abort();
        const normalizedKey = normalizer(value);
        if (
          normalizedKey === '[object Object]' &&
          typeof value === 'object' &&
          value !== null
        ) {
          const err = new Error(
            'queryQuorum: object value requires explicit normalize() — default String(v) collapses all objects to "[object Object]"',
          );
          err.isDeveloperError = true;
          throw err;
        }
        return { url, status: 'fulfilled', value, normalizedKey };
      },
      (err) => {
        clearTimeout(timerHandle);
        // Abort the underlying fetch so undici tears down the socket immediately
        // instead of waiting for the server-side TCP timeout (which can be 60+s).
        controller.abort();
        if (err && err.isDeveloperError) throw err;
        return {
          url,
          status: 'rejected',
          error: err?.message ?? String(err),
        };
      },
    );
  }

  // ── mode: 'any' ─────────────────────────────────────────────────────────────
  // Sequential first-success: try each URL in order, return on the first
  // success WITHOUT touching later URLs. This matches the help-text contract
  // ("first-success, single provider queried") and avoids tripling load on
  // shared free-tier RPCs by default. majority/all stay parallel below.
  if (mode === 'any') {
    /** @type {Array<{url:string,status:'fulfilled'|'rejected',value?:*,normalizedKey?:string,error?:string}>} */
    const sources = [];
    const errors = [];
    let winnerSlot = null;

    for (const url of urls) {
      const slot = await execWithTimeout(url);
      sources.push(slot);
      if (slot.status === 'fulfilled') {
        winnerSlot = slot;
        break;
      }
      errors.push(`${redactUrl(slot.url)}: ${slot.error ?? 'unknown'}`);
    }

    if (winnerSlot === null) {
      throw new Error('all RPC providers failed: ' + errors.join('; '));
    }

    // Fill in untried URLs (those after the winner) with status:'rejected',
    // error:'not-tried' so callers can distinguish "we tried and it failed"
    // from "we never made a request".
    const triedUrls = new Set(sources.map((s) => s.url));
    for (const url of urls) {
      if (!triedUrls.has(url)) {
        sources.push({ url, status: 'rejected', error: 'not-tried' });
      }
    }

    return {
      value: winnerSlot.value,
      source: winnerSlot.url,
      sources,
      agreement: 'single',
      disagreements: [],
      mode: 'any',
    };
  }

  // ── mode: 'majority' | 'all' ─────────────────────────────────────────────────
  //
  // Early-exit streaming accumulator.
  //
  // The naive Promise.allSettled approach forces the caller to wait for every
  // URL to either respond or hit timeoutMs.  With 3 RPCs where one or two are
  // slow/broken, that means waiting up to timeoutMs (default 10 s) or longer —
  // even when the answer is already known from the fast providers.  That is the
  // root cause of the observed CLI hangs ("data flushed within ~1s but process
  // hangs 10–60 s before exiting").
  //
  // Fix: tag each in-flight promise with its index so we can identify which one
  // settled via Promise.race, then check early-exit conditions after each
  // settlement.  When the result is decided, abort every remaining request
  // immediately so their undici sockets are torn down rather than waiting for
  // the full TCP timeout to elapse.
  //
  // Early-exit rules
  //   majority — return as soon as ⌈N/2⌉+1 responses agree on one key, OR as
  //              soon as it becomes mathematically impossible for any key to
  //              reach that threshold (fall to plurality).
  //   all      — return when ALL URLs have settled (same as before when they all
  //              agree), but throw RpcDisagreementError the moment a second
  //              distinct key is seen (fail-fast on disagreement).
  //
  // Remaining (un-settled) URLs are represented in sources as
  // { status: 'rejected', error: 'aborted' } so callers always receive an
  // entry for every queried URL.

  const totalUrls = urls.length;
  const majorityThreshold = Math.floor(totalUrls / 2) + 1;

  // Build one entry per URL.  Exposes an abort() callback so we can cancel both
  // the internal timer and the undici connection when we decide to stop early.
  /** @type {Array<{idx:number, url:string, promise:Promise<*>, abort:()=>void}>} */
  const inflightEntries = urls.map((url, idx) => {
    const controller = new AbortController();
    const client = makeClient(url, viemChain, controller.signal);

    let timerHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timerHandle = setTimeout(
        () => reject(new Error(`timeout after ${timeoutMs}ms querying ${redactUrl(url)}`)),
        timeoutMs,
      );
    });

    // This promise ALWAYS fulfills (never rejects): errors become
    // { status:'rejected', ... } entries.  Developer errors are the sole
    // exception — they are re-thrown so the outer loop propagates them.
    const promise = Promise.race([exec(client), timeoutPromise]).then(
      (value) => {
        clearTimeout(timerHandle);
        controller.abort();
        const normalizedKey = normalizer(value);
        if (
          normalizedKey === '[object Object]' &&
          typeof value === 'object' &&
          value !== null
        ) {
          const err = new Error(
            'queryQuorum: object value requires explicit normalize() — default String(v) collapses all objects to "[object Object]"',
          );
          err.isDeveloperError = true;
          throw err;
        }
        return { idx, url, status: 'fulfilled', value, normalizedKey };
      },
      (err) => {
        clearTimeout(timerHandle);
        controller.abort();
        if (err && err.isDeveloperError) throw err;
        return { idx, url, status: 'rejected', error: err?.message ?? String(err) };
      },
    );

    return {
      idx,
      url,
      promise,
      abort: () => { clearTimeout(timerHandle); controller.abort(); },
    };
  });

  // O(1) lookup by index when aborting remaining entries.
  const entryByIdx = new Map(inflightEntries.map((e) => [e.idx, e]));

  // Indices of URLs not yet settled.
  const pendingIndices = new Set(inflightEntries.map((e) => e.idx));

  /** @type {Array<{url:string, status:'fulfilled'|'rejected', value?:*, normalizedKey?:string, error?:string}>} */
  const sources = [];

  /** @type {Map<string, Array<{url:string,status:'fulfilled',value:*,normalizedKey:string}>>} */
  const groups = new Map();

  /** @type {Array<{url:string,status:'fulfilled',value:*,normalizedKey:string}>} */
  const fulfilled = [];

  /**
   * Abort every still-pending request and append a placeholder source entry
   * (status:'rejected', error:'aborted') for each.
   */
  function abortAndDrainPending() {
    for (const idx of pendingIndices) {
      const entry = entryByIdx.get(idx);
      if (entry) {
        entry.abort();
        sources.push({ url: entry.url, status: 'rejected', error: 'aborted' });
      }
    }
    pendingIndices.clear();
  }

  // Stream results one at a time using Promise.race on the pending set.
  while (pendingIndices.size > 0) {
    const racePromises = [...pendingIndices].map((idx) => entryByIdx.get(idx).promise);
    const slot = await Promise.race(racePromises);

    // slot.idx identifies which entry resolved — O(1) removal.
    pendingIndices.delete(slot.idx);

    // Re-throw developer errors (object-normalize footgun) immediately.
    // (These cause the promise to reject rather than fulfill, so they propagate
    // through Promise.race naturally; the isDeveloperError check is a safety net.)
    if (slot.isDeveloperError) throw slot;

    // Strip internal idx before storing in the public sources array.
    const { idx: _idx, ...publicSlot } = slot;
    sources.push(publicSlot);

    if (slot.status === 'fulfilled') {
      fulfilled.push(publicSlot);
      const key = slot.normalizedKey;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(publicSlot);

      if (mode === 'all') {
        // Fail fast the moment a second distinct key appears.
        if (groups.size > 1) {
          abortAndDrainPending();
          throw new RpcDisagreementError({
            urls,
            values: fulfilled.map((s) => ({ url: s.url, normalizedKey: s.normalizedKey, value: s.value })),
          });
        }
        // All agree so far — keep accumulating.
      } else {
        // mode === 'majority'
        const groupSize = groups.get(key).length;
        if (groupSize >= majorityThreshold) {
          // Unassailable mathematical majority — return immediately.
          abortAndDrainPending();
          const winnerSlot = groups.get(key)[0];
          const losingMembers = fulfilled.filter((s) => s.normalizedKey !== key);
          const earlyAgreement = losingMembers.length > 0
            ? 'majority'
            : fulfilled.length === 1 ? 'single' : 'unanimous';
          return {
            value: winnerSlot.value,
            source: winnerSlot.url,
            sources: [...sources],
            agreement: earlyAgreement,
            disagreements: losingMembers.map((s) => ({
              url: s.url,
              value: s.value,
              normalizedKey: s.normalizedKey,
            })),
            mode: 'majority',
          };
        }

        // Even if every remaining pending URL joined the best group, could it
        // still reach majority threshold?  If not, no point waiting further.
        const remaining = pendingIndices.size;
        const bestGroupSize = Math.max(...[...groups.values()].map((g) => g.length));
        if (bestGroupSize + remaining < majorityThreshold) {
          abortAndDrainPending();
          break; // fall through to post-loop majority/plurality calculation
        }

        // Winner-is-decided check: even without reaching majority threshold,
        // the current leader may be guaranteed to win the plurality tie-break
        // regardless of how all remaining pending URLs resolve.
        //
        // A leader with `L` votes cannot be dethroned when:
        //   L >= bestRivalSize + remaining
        // because even if every remaining URL joined the best rival group, the
        // rival's total (bestRivalSize + remaining) would not exceed L.  In a
        // tie (L == bestRivalSize + remaining) the tie is broken by first-
        // arrival; since the leader group appeared earlier in `fulfilled`, it
        // wins the tie.
        //
        // Guard: only apply when we already have at least 2 fulfilled responses.
        // With only 1 fulfilled response the remaining URL could still turn a
        // 'single' result into 'unanimous' (same value) or 'majority' (agreeing
        // with a third party) — semantically meaningful upgrades.  Waiting for
        // the second response costs little and gives callers richer metadata.
        //
        // This handles the common production case: two fast RPCs agree, one
        // slow RPC is still pending.  The winner is already decided — waiting
        // for the slow RPC only affects the `agreement` label, not the value.
        if (remaining > 0 && fulfilled.length >= 2) {
          const sortedEntries = [...groups.entries()].sort(([, a], [, b]) => {
            if (b.length !== a.length) return b.length - a.length;
            return fulfilled.indexOf(a[0]) - fulfilled.indexOf(b[0]);
          });
          const leaderSize = sortedEntries[0][1].length;
          const bestRivalSize = sortedEntries.length > 1 ? sortedEntries[1][1].length : 0;
          if (leaderSize >= bestRivalSize + remaining) {
            // Winner is decided — remaining can neither change nor tie-beat it.
            abortAndDrainPending();
            break; // fall through to post-loop calculation with current data
          }
        }
      }
    } else {
      // Rejected slot — check whether majority is still reachable or the
      // winner is already decided.
      if (mode === 'majority') {
        const remaining = pendingIndices.size;
        const bestGroupSize = groups.size > 0
          ? Math.max(...[...groups.values()].map((g) => g.length))
          : 0;
        if (bestGroupSize + remaining < majorityThreshold) {
          abortAndDrainPending();
          break;
        }

        // Winner-is-decided check (same logic as the fulfilled branch above).
        // Only apply with >= 2 fulfilled responses (same reasoning as above).
        if (remaining > 0 && fulfilled.length >= 2 && groups.size > 0) {
          const sortedEntries = [...groups.entries()].sort(([, a], [, b]) => {
            if (b.length !== a.length) return b.length - a.length;
            return fulfilled.indexOf(a[0]) - fulfilled.indexOf(b[0]);
          });
          const leaderSize = sortedEntries[0][1].length;
          const bestRivalSize = sortedEntries.length > 1 ? sortedEntries[1][1].length : 0;
          if (leaderSize >= bestRivalSize + remaining) {
            abortAndDrainPending();
            break;
          }
        }
      }
    }
  }

  // ── Post-loop: compute final answer from accumulated sources ─────────────────

  const finalFulfilled = sources.filter(
    (s) => s.status === 'fulfilled' && s.value !== null && s.value !== undefined,
  );

  if (finalFulfilled.length === 0) {
    const reasons = sources
      .map((s) => `${redactUrl(s.url)}: ${s.error ?? 'unknown'}`)
      .join('; ');
    throw new Error('all RPC providers failed: ' + reasons);
  }

  // ── mode: 'all' ──────────────────────────────────────────────────────────────
  if (mode === 'all') {
    // All successful responses agreed (any disagreement would have thrown above).
    const winner = finalFulfilled[0];
    return {
      value: winner.value,
      source: winner.url,
      sources: [...sources],
      agreement: finalFulfilled.length === 1 ? 'single' : 'unanimous',
      disagreements: [],
      mode: 'all',
    };
  }

  // ── mode: 'majority' (post-loop: no mathematical majority reached) ───────────
  // Determine plurality winner from what was collected.
  // `groups` is already populated from the streaming loop above.

  const sortedGroups = [...groups.entries()].sort(([, membersA], [, membersB]) => {
    if (membersB.length !== membersA.length) return membersB.length - membersA.length;
    // Tie: prefer the group whose first member arrived first.
    return finalFulfilled.indexOf(membersA[0]) - finalFulfilled.indexOf(membersB[0]);
  });

  const [winningKey, winningMembers] = sortedGroups[0];
  const losingMembers = finalFulfilled.filter((s) => s.normalizedKey !== winningKey);

  const n = finalFulfilled.length;
  let agreement;
  if (sortedGroups.length === 1) {
    agreement = n === 1 ? 'single' : 'unanimous';
  } else {
    const majority = Math.floor(n / 2) + 1;
    agreement = winningMembers.length >= majority ? 'majority' : 'plurality';
  }

  return {
    value: winningMembers[0].value,
    source: winningMembers[0].url,
    sources: [...sources],
    agreement,
    disagreements: losingMembers.map((s) => ({
      url: s.url,
      value: s.value,
      normalizedKey: s.normalizedKey,
    })),
    mode: 'majority',
  };
}
