/**
 * src/prices.js
 *
 * Fetch USD prices from CoinGecko's free public API.
 * Caches results in-memory for 60 seconds per entry.
 *
 * Two flavours of each lookup:
 *   - getPrices / getTokenPrices       → return { SYMBOL: number } directly
 *   - getPricesWithMeta /
 *     getTokenPricesWithMeta           → return { prices, meta } where meta
 *                                        carries provider, ok, cacheAgeSec,
 *                                        stale, rateLimited, unpriced[]
 *
 * The plain-map variants are kept for callers that never look at freshness
 * (alert/gas paths). The balance pipeline uses the With-Meta variants so the
 * JSON envelope can expose source freshness to scripted consumers.
 *
 * symbol is case-insensitive and mapped to CoinGecko IDs internally.
 * contractAddresses are lowercased EVM contract addresses.
 */

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

// In-memory cache: coingeckoId → { price: number, cachedAt: number }
const priceCache = new Map();

// In-memory cache for contract-address prices: `${chainName}:${address}` → { price: number, cachedAt: number }
const contractPriceCache = new Map();

const PRICE_TTL_MS = 60 * 1000; // 60 seconds

// Map common ticker symbols → CoinGecko coin IDs
const SYMBOL_TO_ID = {
  eth:    'ethereum',
  weth:   'weth',
  wbtc:   'wrapped-bitcoin',
  btc:    'bitcoin',
  usdc:   'usd-coin',
  usdt:   'tether',
  dai:    'dai',
  pol:    'polygon-ecosystem-token', // Polygon native (ex-MATIC, renamed Sept 2024)
  matic:  'polygon-ecosystem-token', // legacy alias
  wmatic: 'wmatic',
  sol:    'solana',
  bnb:    'binancecoin',
  arb:    'arbitrum',
};

// CoinGecko platform IDs per EVM chain name
const CHAIN_TO_PLATFORM = {
  ethereum: 'ethereum',
  polygon:  'polygon-pos',
  arbitrum: 'arbitrum-one',
  base:     'base',
  optimism: 'optimistic-ethereum',
  linea:    'linea',
  zksync:   'zksync',
};

const BATCH_SIZE = 100; // CoinGecko URL length safety limit

/**
 * Fetch with exponential backoff on transient failures: HTTP 429, 5xx, and
 * thrown errors (network/timeouts). A fresh AbortSignal is created per attempt
 * so the timeout is not consumed by the inter-attempt wait.
 *
 * Returns { res, rateLimited, networkErrored } so the caller can tell apart
 * "non-2xx response" from "all attempts threw" from "rate-limited even after
 * the final retry."
 *
 * @param {string} url
 * @param {number} timeoutMs  - per-attempt timeout
 * @param {number} [maxRetries=3]
 * @returns {Promise<{ res: Response|null, rateLimited: boolean, networkErrored: boolean }>}
 */
async function fetchWithRetry(url, timeoutMs, maxRetries = 3) {
  const headers = { Accept: 'application/json' };
  let delay = 1_000;
  let rateLimited = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // Network error / timeout / abort — retry unless we're out of attempts.
      if (attempt === maxRetries) {
        return { res: null, rateLimited, networkErrored: true };
      }
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    if (res.status === 429) rateLimited = true;
    // Success or non-transient failure (4xx other than 429) → return it.
    if (res.status !== 429 && res.status < 500) {
      return { res, rateLimited, networkErrored: false };
    }
    if (attempt === maxRetries) {
      return { res, rateLimited, networkErrored: false };
    }
    const ra = res.headers.get('Retry-After');
    const wait = ra ? Math.min(Number(ra) * 1_000, 30_000) : delay;
    await new Promise(r => setTimeout(r, wait));
    delay *= 2;
  }
  // Unreachable — every loop iteration either returns or `continue`s past.
  return { res: null, rateLimited, networkErrored: true };
}

/**
 * Return true if a cached entry is still within the TTL.
 *
 * @param {{ cachedAt: number }} entry
 * @returns {boolean}
 */
function isFresh(entry) {
  return entry && (Date.now() - entry.cachedAt) < PRICE_TTL_MS;
}

/**
 * Empty meta block — the shape used when no upstream fetch was attempted at
 * all (e.g. zero symbols requested).
 *
 * @returns {{ ok: boolean, provider: string, cacheAgeSec: number, stale: boolean, rateLimited: boolean, unpriced: string[] }}
 */
function freshMeta() {
  return {
    ok: true,
    provider: 'coingecko',
    cacheAgeSec: 0,
    stale: false,
    rateLimited: false,
    unpriced: [],
  };
}

/**
 * Fetch prices for the given ticker symbols, returning a structured envelope
 * carrying both the price map and freshness metadata.
 *
 * `meta.ok`         — true unless every attempted upstream call failed.
 * `meta.cacheAgeSec` — age of the OLDEST price returned (worst case).
 * `meta.stale`       — true iff any returned price was past the 60s TTL when
 *                      served from cache (only possible on upstream failure).
 * `meta.rateLimited` — STICKY: true if CoinGecko returned 429 at any point
 *                      during this call, even if a subsequent retry returned
 *                      a 2xx. Treat it as "we saw rate-limit pressure," not
 *                      as "every attempt failed."
 * `meta.unpriced`    — symbols we know about but couldn't price (or unknown).
 *                      Always uppercase ticker symbols from this function.
 *
 * @param {string[]} symbols
 * @returns {Promise<{ prices: Record<string, number>, meta: ReturnType<typeof freshMeta> }>}
 */
export async function getPricesWithMeta(symbols) {
  const meta = freshMeta();
  const normalised = [...new Set(symbols.map(s => s.toLowerCase()))];

  // Only fetch symbols whose cached entry is absent or stale
  const missing = normalised.filter(sym => {
    const id = SYMBOL_TO_ID[sym];
    if (id === undefined) return false;
    const cached = priceCache.get(id);
    return !cached || !isFresh(cached);
  });

  let networkAttempted = false;
  let networkSucceeded = false;

  if (missing.length > 0) {
    const ids = [...new Set(missing.map(s => SYMBOL_TO_ID[s]).filter(Boolean))];
    if (ids.length > 0) {
      networkAttempted = true;
      const url =
        `${COINGECKO_BASE}/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
      const { res, rateLimited, networkErrored } = await fetchWithRetry(url, 8_000);
      if (rateLimited) meta.rateLimited = true;
      if (res && res.ok) {
        try {
          const data = await res.json();
          for (const [id, val] of Object.entries(data)) {
            priceCache.set(id, { price: val?.usd ?? 0, cachedAt: Date.now() });
          }
          networkSucceeded = true;
        } catch {
          // Malformed JSON — treat as network failure, fall through to cache.
        }
      } else if (networkErrored) {
        // No response at all — treat as upstream failure.
      }
    }
  }

  if (networkAttempted && !networkSucceeded) {
    meta.ok = false;
  }

  const result = {};
  let oldestAgeMs = 0;
  const now = Date.now();

  for (const sym of normalised) {
    const id = SYMBOL_TO_ID[sym];
    if (!id) {
      meta.unpriced.push(sym.toUpperCase());
      continue;
    }
    const cached = priceCache.get(id);
    if (cached) {
      result[sym.toUpperCase()] = cached.price;
      const ageMs = now - cached.cachedAt;
      if (ageMs > oldestAgeMs) oldestAgeMs = ageMs;
    } else {
      meta.unpriced.push(sym.toUpperCase());
    }
  }

  meta.cacheAgeSec = Math.floor(oldestAgeMs / 1000);
  meta.stale = oldestAgeMs > PRICE_TTL_MS;

  return { prices: result, meta };
}

/**
 * Backwards-compatible flat-map flavour.
 * Symbols that are unknown or fail are omitted.
 *
 * @param {string[]} symbols
 * @returns {Promise<Record<string, number>>}
 */
export async function getPrices(symbols) {
  const { prices } = await getPricesWithMeta(symbols);
  return prices;
}

/**
 * Convenience helper — returns single price or 0.
 *
 * @param {string} symbol
 * @returns {Promise<number>}
 */
export async function getPrice(symbol) {
  const map = await getPrices([symbol]);
  return map[symbol.toUpperCase()] ?? 0;
}

/**
 * Fetch USD prices for EVM tokens identified by contract address, with meta.
 *
 * @param {string}   chainName
 * @param {string[]} contractAddresses  - lowercased EVM contract addresses
 * @returns {Promise<{ prices: Record<string, number>, meta: ReturnType<typeof freshMeta> }>}
 */
export async function getTokenPricesWithMeta(chainName, contractAddresses) {
  const meta = freshMeta();

  const platform = CHAIN_TO_PLATFORM[chainName];
  if (!platform || !contractAddresses || contractAddresses.length === 0) {
    return { prices: {}, meta };
  }

  const addresses = [...new Set(contractAddresses.map(a => a.toLowerCase()))];

  const toFetch = addresses.filter(addr => {
    const cached = contractPriceCache.get(`${chainName}:${addr}`);
    return !cached || !isFresh(cached);
  });

  let networkAttempted = false;
  let networkSucceeded = false;

  // ── Batch-fetch stale/missing addresses sequentially ───────────────────────
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    const csv   = batch.join(',');
    const url   =
      `${COINGECKO_BASE}/simple/token_price/${platform}` +
      `?contract_addresses=${csv}&vs_currencies=usd`;

    networkAttempted = true;
    const { res, rateLimited } = await fetchWithRetry(url, 10_000);
    if (rateLimited) meta.rateLimited = true;
    if (res && res.ok) {
      try {
        const data = await res.json();
        for (const [addr, val] of Object.entries(data)) {
          const normAddr = addr.toLowerCase();
          const usd = val?.usd;
          if (typeof usd === 'number') {
            contractPriceCache.set(`${chainName}:${normAddr}`, {
              price: usd,
              cachedAt: Date.now(),
            });
          }
        }
        // One successful batch is enough to flip the flag.
        networkSucceeded = true;
      } catch {
        // Malformed JSON — fall through to cache.
      }
    }
  }

  if (networkAttempted && !networkSucceeded) {
    meta.ok = false;
  }

  const result = {};
  let oldestAgeMs = 0;
  const now = Date.now();

  for (const addr of addresses) {
    const cached = contractPriceCache.get(`${chainName}:${addr}`);
    if (cached) {
      result[addr] = cached.price;
      const ageMs = now - cached.cachedAt;
      if (ageMs > oldestAgeMs) oldestAgeMs = ageMs;
    } else {
      meta.unpriced.push(addr);
    }
  }

  meta.cacheAgeSec = Math.floor(oldestAgeMs / 1000);
  meta.stale = oldestAgeMs > PRICE_TTL_MS;

  return { prices: result, meta };
}

/**
 * Backwards-compatible flat-map flavour for contract-address prices.
 *
 * @param {string}   chainName
 * @param {string[]} contractAddresses
 * @returns {Promise<Record<string, number>>}
 */
export async function getTokenPrices(chainName, contractAddresses) {
  const { prices } = await getTokenPricesWithMeta(chainName, contractAddresses);
  return prices;
}

/**
 * Merge two price meta blocks into a single combined block. Used when a
 * caller pulls both symbol-keyed and contract-keyed prices in the same flow
 * (the balance command) and wants one consolidated `meta.sources.prices`.
 *
 * - `ok`           AND across inputs (any failure makes the combined block not-ok)
 * - `rateLimited`  OR  across inputs
 * - `stale`        OR  across inputs
 * - `cacheAgeSec`  MAX of inputs
 * - `unpriced`     concat + de-dup. NOTE: this is a heterogenous bag —
 *                  uppercase ticker symbols from getPricesWithMeta and
 *                  lowercase 0x… contract addresses from
 *                  getTokenPricesWithMeta. They denote the same conceptual
 *                  "couldn't price this thing" outcome but consumers
 *                  inspecting `unpriced` should expect both forms.
 *
 * @param {...({ ok: boolean, provider: string, cacheAgeSec: number, stale: boolean, rateLimited: boolean, unpriced: string[] })} blocks
 */
export function mergePricesMeta(...blocks) {
  const merged = freshMeta();
  const unpriced = new Set();
  let any = false;
  for (const m of blocks) {
    if (!m) continue;
    any = true;
    if (!m.ok) merged.ok = false;
    if (m.rateLimited) merged.rateLimited = true;
    if (m.stale) merged.stale = true;
    if (typeof m.cacheAgeSec === 'number' && m.cacheAgeSec > merged.cacheAgeSec) {
      merged.cacheAgeSec = m.cacheAgeSec;
    }
    for (const sym of m.unpriced ?? []) unpriced.add(sym);
  }
  if (!any) return merged;
  merged.unpriced = [...unpriced];
  return merged;
}
