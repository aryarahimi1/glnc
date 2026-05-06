/**
 * src/prices.js
 *
 * Fetch USD prices from CoinGecko's free public API.
 * Caches results in-memory for 60 seconds per entry.
 *
 * Exports:
 *   getPrices(symbols: string[])                       => Promise<Record<string, number>>
 *   getPrice(symbol: string)                           => Promise<number>   (0 if unknown)
 *   getTokenPrices(chainName, contractAddresses)       => Promise<Record<string, number>>
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
};

const BATCH_SIZE = 100; // CoinGecko URL length safety limit

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
 * Fetch prices for the given ticker symbols.
 * Returns a map of { SYMBOL_UPPERCASE: usdPrice }.
 * Symbols that are unknown or fail are omitted.
 * De-duplicates: cached symbols are not re-fetched until TTL expires.
 *
 * @param {string[]} symbols
 * @returns {Promise<Record<string, number>>}
 */
export async function getPrices(symbols) {
  const normalised = [...new Set(symbols.map(s => s.toLowerCase()))];

  // Only fetch symbols whose cached entry is absent or stale
  const missing = normalised.filter(sym => {
    const id = SYMBOL_TO_ID[sym];
    if (id === undefined) return false;
    const cached = priceCache.get(id);
    return !cached || !isFresh(cached);
  });

  if (missing.length > 0) {
    const ids = [...new Set(missing.map(s => SYMBOL_TO_ID[s]).filter(Boolean))];
    if (ids.length > 0) {
      try {
        const url =
          `${COINGECKO_BASE}/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json();
          for (const [id, val] of Object.entries(data)) {
            priceCache.set(id, { price: val?.usd ?? 0, cachedAt: Date.now() });
          }
        }
      } catch {
        // Network failure — return whatever is cached
      }
    }
  }

  const result = {};
  for (const sym of normalised) {
    const id = SYMBOL_TO_ID[sym];
    if (id) {
      const cached = priceCache.get(id);
      if (cached) {
        result[sym.toUpperCase()] = cached.price;
      }
    }
  }
  return result;
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
 * Fetch USD prices for EVM tokens identified by contract address.
 *
 * Uses CoinGecko's token_price endpoint.  Batches in groups of 100 addresses
 * and runs batches sequentially to stay within rate limits.
 * Results are cached in-memory for 60 seconds keyed by `${chainName}:${address}`.
 *
 * On any fetch error the function returns whatever was previously cached for
 * the requested addresses — it never throws.
 *
 * @param {string}   chainName          - one of 'ethereum' | 'polygon' | 'arbitrum' | 'base'
 * @param {string[]} contractAddresses  - lowercased EVM contract addresses
 * @returns {Promise<Record<string, number>>}  - { [lowercased_address]: usdPrice }
 */
export async function getTokenPrices(chainName, contractAddresses) {
  const platform = CHAIN_TO_PLATFORM[chainName];
  if (!platform || !contractAddresses || contractAddresses.length === 0) {
    return {};
  }

  // Normalise addresses to lowercase
  const addresses = [...new Set(contractAddresses.map(a => a.toLowerCase()))];

  // Separate stale/missing from already-fresh
  const toFetch = addresses.filter(addr => {
    const key    = `${chainName}:${addr}`;
    const cached = contractPriceCache.get(key);
    return !cached || !isFresh(cached);
  });

  // ── Batch-fetch stale/missing addresses sequentially ────────────────────────
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    const csv   = batch.join(',');
    const url   =
      `${COINGECKO_BASE}/simple/token_price/${platform}` +
      `?contract_addresses=${csv}&vs_currencies=usd`;

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = await res.json();
        for (const [addr, val] of Object.entries(data)) {
          const normAddr = addr.toLowerCase();
          const usd      = val?.usd;
          if (typeof usd === 'number') {
            contractPriceCache.set(`${chainName}:${normAddr}`, {
              price:    usd,
              cachedAt: Date.now(),
            });
          }
        }
      }
      // If response is not ok — fall through and return whatever is cached
    } catch {
      // Network error — fall through and return whatever is cached
    }
  }

  // ── Build result from cache (fresh + just-fetched) ──────────────────────────
  const result = {};
  for (const addr of addresses) {
    const key    = `${chainName}:${addr}`;
    const cached = contractPriceCache.get(key);
    if (cached) {
      result[addr] = cached.price;
    }
  }
  return result;
}
