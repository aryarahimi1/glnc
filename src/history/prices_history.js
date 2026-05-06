/**
 * src/history/prices_history.js
 *
 * Historical USD prices via CoinGecko's /coins/{id}/history endpoint.
 * Free-tier limit is ~10–30 req/min; we keep a 600ms gap to behave well on
 * long backfills. Historical prices for a (coin, day) tuple never change so
 * we cache forever in-memory. Decoupled from src/prices.js on purpose to
 * avoid cyclic-dep risk.
 */

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

const SYMBOL_TO_ID = {
  eth:    'ethereum',
  btc:    'bitcoin',
  weth:   'weth',
  wbtc:   'wrapped-bitcoin',
  usdc:   'usd-coin',
  usdt:   'tether',
  dai:    'dai',
  pol:    'polygon-ecosystem-token',
  matic:  'polygon-ecosystem-token',
  wmatic: 'wmatic',
  sol:    'solana',
  bnb:    'binancecoin',
  arb:    'arbitrum',
  op:     'optimism',
  link:   'chainlink',
  uni:    'uniswap',
  aave:   'aave',
  crv:    'curve-dao-token',
  ldo:    'lido-dao',
  mkr:    'maker',
  snx:    'havven',
  gmx:    'gmx',
};

const CHAIN_NATIVE_SYMBOL = {
  ethereum: 'eth',
  polygon:  'pol',
  arbitrum: 'eth',
  base:     'eth',
  optimism: 'eth',
};

// `${coinId}|${ddmmyyyy}` → { usd: number|null, cachedAt: number }
const priceCache = new Map();

const MIN_REQUEST_GAP_MS = 600;
let lastRequestAt = 0;

async function rateLimitGate() {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/**
 * Convert a unix timestamp (seconds) into CoinGecko's expected DD-MM-YYYY (UTC).
 * @param {number} unixSec
 * @returns {string}
 */
export function toCoinGeckoDate(unixSec) {
  const d = new Date(unixSec * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

// Accepts a ticker ('ETH'/'eth') or chain name ('ethereum'); null when unmapped.
// Callers MUST treat null as "skip the HTTP call".
function resolveCoinId(symbol) {
  if (!symbol) return null;
  const k = symbol.toLowerCase();
  if (CHAIN_NATIVE_SYMBOL[k]) return SYMBOL_TO_ID[CHAIN_NATIVE_SYMBOL[k]] ?? null;
  return SYMBOL_TO_ID[k] ?? null;
}

// Caches even null — historical misses are stable too.
async function fetchOne(coinId, ddmmyyyy, opts = {}) {
  const key = `${coinId}|${ddmmyyyy}`;
  if (priceCache.has(key)) return priceCache.get(key).usd;

  await rateLimitGate();
  const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(coinId)}/history`
            + `?date=${ddmmyyyy}&localization=false`;

  let usd = null;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal:  opts.signal ?? AbortSignal.timeout(12_000),
    });
    if (res.ok) {
      const data = await res.json();
      const v = data?.market_data?.current_price?.usd;
      if (typeof v === 'number' && Number.isFinite(v)) usd = v;
    } else {
      opts.onWarn?.(`coingecko history: HTTP ${res.status} for ${coinId} on ${ddmmyyyy}`);
    }
  } catch {
    opts.onWarn?.(`coingecko history: network error for ${coinId} on ${ddmmyyyy}`);
  }

  priceCache.set(key, { usd, cachedAt: Date.now() });
  return usd;
}

/**
 * Get the historical USD price for a single symbol at a unix-second timestamp.
 * @param {string} symbol  - case-insensitive ticker
 * @param {number} unixSec - tx timestamp in seconds
 * @param {{ signal?: AbortSignal, onWarn?: (m: string) => void }} [opts]
 * @returns {Promise<number|null>} USD price at that day, or null if unknown
 */
export async function getHistoricalPrice(symbol, unixSec, opts) {
  const coinId = resolveCoinId(symbol);
  if (!coinId) return null;
  return fetchOne(coinId, toCoinGeckoDate(unixSec), opts);
}

/**
 * Batched lookup. Deduplicates by (coinId, day) so 100 swaps on the same day
 * cost one HTTP request per unique symbol/day combination.
 * @param {Array<{ symbol: string, unixSec: number }>} requests
 * @param {{ signal?: AbortSignal, onWarn?: (m: string) => void }} [opts]
 * @returns {Promise<Map<string, number|null>>} keyed by `${SYMBOL_UPPERCASE}|${unixSec}`
 */
export async function getHistoricalPrices(requests, opts) {
  const result = new Map();
  if (!requests || requests.length === 0) return result;

  // Dedupe at (coinId, day) so we make the minimum number of network calls.
  const uniquePairs = new Map(); // pairKey → { coinId, ddmmyyyy }
  const reverse     = new Map(); // pairKey → resultKey[]

  for (const { symbol, unixSec } of requests) {
    const resultKey = `${symbol.toUpperCase()}|${unixSec}`;
    const coinId = resolveCoinId(symbol);
    if (!coinId) { result.set(resultKey, null); continue; }
    const ddmmyyyy = toCoinGeckoDate(unixSec);
    const pairKey  = `${coinId}|${ddmmyyyy}`;
    if (!uniquePairs.has(pairKey)) uniquePairs.set(pairKey, { coinId, ddmmyyyy });
    if (!reverse.has(pairKey))     reverse.set(pairKey, []);
    reverse.get(pairKey).push(resultKey);
  }

  // Sequential — the rate-limit gate is global so parallelism wouldn't help.
  for (const [pairKey, { coinId, ddmmyyyy }] of uniquePairs) {
    const usd = await fetchOne(coinId, ddmmyyyy, opts);
    for (const rk of reverse.get(pairKey)) result.set(rk, usd);
  }

  return result;
}
