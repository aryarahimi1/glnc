/**
 * src/nfts/reservoir.js
 *
 * Reservoir API client — fetches NFT collection holdings for a single EVM
 * address on one supported chain.  Returns a normalised, spam-filtered shape.
 *
 * Free public API; optional x-api-key for higher rate limits.  We enforce a
 * 250ms minimum gap between requests *inside this module* to stay polite on
 * anonymous use; the queue is a single shared cursor (not per-chain) because
 * Reservoir rate-limits per IP regardless of subdomain.
 *
 * Exports:
 *   getReservoirHoldings(chain, address, opts) → Promise<ReservoirResult>
 */

// ─── Per-chain API base URLs ─────────────────────────────────────────────────

const RESERVOIR_BASES = {
  ethereum: 'https://api.reservoir.tools',
  polygon:  'https://api-polygon.reservoir.tools',
  arbitrum: 'https://api-arbitrum.reservoir.tools',
  base:     'https://api-base.reservoir.tools',
  optimism: 'https://api-optimism.reservoir.tools',
};

// Polygon native token rebrand (MATIC → POL, Sept 2024). All other supported
// chains settle in ETH for floor pricing on Reservoir.
const NATIVE_SYMBOL = {
  ethereum: 'ETH',
  polygon:  'POL',
  arbitrum: 'ETH',
  base:     'ETH',
  optimism: 'ETH',
};

const PAGE_LIMIT       = 100;
const MAX_COLLECTIONS  = 500;          // wallets > 500 collections are spam farms
const CACHE_TTL_MS     = 60 * 1000;
const REQUEST_GAP_MS   = 250;
const REQUEST_TIMEOUT  = 12_000;

// ─── In-memory cache ──────────────────────────────────────────────────────────

// key: `${chain}|${address.toLowerCase()}` → { result, cachedAt }
const _cache = new Map();

// Shared rate-limit cursor across all chains (Reservoir limits per IP).
let _lastRequestAt = 0;

/**
 * Sleep until the global rate-limit window opens, then advance the cursor.
 *
 * Centralising the gap here means callers don't need to think about it; the
 * pagination loop and any future retry logic share the same fairness.
 *
 * @returns {Promise<void>}
 */
async function rateLimit() {
  const now  = Date.now();
  const wait = Math.max(0, _lastRequestAt + REQUEST_GAP_MS - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestAt = Date.now();
}

/**
 * Strip C0/C1 control chars and trim — Reservoir spam projects pad names with
 * zero-width and bidi overrides to phish search results.  We do NOT strip
 * other unicode (legit collections may contain emoji or CJK).
 *
 * @param {string} s
 * @returns {string}
 */
function cleanName(s) {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
}

/**
 * Fetch NFT holdings for an address on a single EVM chain.
 *
 * @param {string} chain    'ethereum' | 'polygon' | 'arbitrum' | 'base' | 'optimism'
 * @param {string} address  EVM 0x-prefixed address (any case)
 * @param {{ apiKey?: string, signal?: AbortSignal, onWarn?: (msg: string) => void }} [opts]
 * @returns {Promise<{
 *   chain: string,
 *   address: string,
 *   collections: Array<{
 *     name: string,
 *     slug: string|null,
 *     contract: string,
 *     count: number,
 *     floorNative: number|null,
 *     floorUsd: number|null,
 *     totalNative: number|null,
 *     totalUsd: number|null,
 *   }>,
 *   totalCount: number,
 *   totalNative: number|null,
 *   totalUsd: number|null,
 *   nativeSymbol: string,
 *   error: string|null,
 *   truncated: boolean,
 * }>}
 */
export async function getReservoirHoldings(chain, address, opts = {}) {
  const base   = RESERVOIR_BASES[chain];
  const symbol = NATIVE_SYMBOL[chain] ?? 'ETH';
  const addr   = (address ?? '').toLowerCase();

  const empty = {
    chain,
    address:      addr,
    collections:  [],
    totalCount:   0,
    totalNative:  null,
    totalUsd:     null,
    nativeSymbol: symbol,
    error:        null,
    truncated:    false,
  };

  if (!base) return { ...empty, error: 'Unsupported chain' };

  const cacheKey = `${chain}|${addr}`;
  const cached   = _cache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
    return cached.result;
  }

  const apiKey = opts.apiKey ?? process.env.RESERVOIR_API_KEY;
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const raw = [];
  let truncated = false;

  try {
    let offset = 0;
    while (true) {
      await rateLimit();

      const url =
        `${base}/users/${addr}/collections/v3` +
        `?limit=${PAGE_LIMIT}&offset=${offset}&includeTopBid=false`;

      const res = await fetch(url, {
        headers,
        // Honour caller's signal if supplied; otherwise fall back to per-page timeout.
        signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT),
      });

      if (!res.ok) {
        // 429 / 5xx — surface to caller so they can decide whether to retry.
        return { ...empty, error: `Reservoir HTTP ${res.status}` };
      }

      const json = await res.json();
      const page = Array.isArray(json?.collections) ? json.collections : [];
      raw.push(...page);

      if (page.length < PAGE_LIMIT) break;        // last page
      offset += PAGE_LIMIT;

      if (raw.length >= MAX_COLLECTIONS) {
        truncated = true;
        opts.onWarn?.(
          `[nfts] ${chain}: capped at ${MAX_COLLECTIONS} collections (likely spam-heavy wallet)`,
        );
        break;
      }
    }
  } catch (err) {
    // Network/timeout — never throw to caller, surface as error string.
    return { ...empty, error: err?.message ?? String(err) };
  }

  // ── Normalise + spam-filter ────────────────────────────────────────────────

  const collections = [];
  for (const entry of raw) {
    const c = entry?.collection ?? {};
    const o = entry?.ownership  ?? {};
    const name = cleanName(c.name);
    if (!name) continue;                          // empty/whitespace name

    const count = parseInt(o.tokenCount, 10);
    if (!Number.isFinite(count) || count <= 0) continue;

    const floor       = c.floorAskPrice?.amount ?? null;
    const floorNative = typeof floor?.native  === 'number' ? floor.native  : null;
    const floorUsd    = typeof floor?.usd     === 'number' ? floor.usd     : null;

    // Conservative airdrop heuristic: no listings + huge bag = spam.
    if (floor == null && count > 50) continue;

    collections.push({
      name,
      slug:        typeof c.slug === 'string' ? c.slug : null,
      contract:    typeof c.id   === 'string' ? c.id.toLowerCase() : '',
      count,
      floorNative,
      floorUsd,
      totalNative: floorNative == null ? null : floorNative * count,
      totalUsd:    floorUsd    == null ? null : floorUsd    * count,
    });
  }

  // Sort by totalUsd desc, nulls last, stable on tie by name.
  collections.sort((a, b) => {
    const av = a.totalUsd, bv = b.totalUsd;
    if (av == null && bv == null) return a.name.localeCompare(b.name);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (bv !== av) return bv - av;
    return a.name.localeCompare(b.name);
  });

  // Totals.  Honest-about-unknowns: if any kept collection lacks a floor, the
  // chain-level total would be misleading, so we null both totals.
  let totalCount  = 0;
  let totalNative = 0;
  let totalUsd    = 0;
  let allHaveFloor = true;
  for (const c of collections) {
    totalCount += c.count;
    if (c.floorNative == null || c.floorUsd == null) {
      allHaveFloor = false;
    } else {
      totalNative += c.totalNative;
      totalUsd    += c.totalUsd;
    }
  }

  const result = {
    chain,
    address:      addr,
    collections,
    totalCount,
    totalNative:  allHaveFloor ? totalNative : null,
    totalUsd:     allHaveFloor ? totalUsd    : null,
    nativeSymbol: symbol,
    error:        null,
    truncated,
  };

  _cache.set(cacheKey, { result, cachedAt: Date.now() });
  return result;
}
