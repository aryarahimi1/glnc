/**
 * src/tokens/index.js
 *
 * Token auto-discovery via the Uniswap token list.
 * Falls back to hardcoded TOKEN_LISTS from _evm.js on any failure.
 *
 * Exports:
 *   getTokenList(chainName) => Promise<{ symbol, contract, decimals, name }[]>
 */

import { getAddress } from 'viem';
import { TOKEN_LISTS } from '../chains/_evm.js';

const UNISWAP_TOKEN_LIST_URL = 'https://tokens.uniswap.org';

const CHAIN_IDS = {
  ethereum: 1,
  polygon:  137,
  arbitrum: 42161,
  base:     8453,
};

// In-memory singleton per chain — populated after first successful fetch.
// Keyed by chainName.
const _resolved = new Map();

/**
 * Attempt to read from the disk cache written by src/tokens/cache.js.
 * Returns the raw token array or null if unavailable / stale.
 *
 * The cache module is written by a concurrent agent, so we import dynamically
 * and swallow any errors.
 *
 * @returns {Promise<{ tokens: object[] } | null>}
 */
async function tryReadCache() {
  try {
    const cache = await import('./cache.js');
    return await cache.readCache();
  } catch {
    return null;
  }
}

/**
 * Attempt to persist fetched data to the disk cache.
 * Silently ignores any errors — cache is best-effort.
 *
 * @param {object} data  - raw Uniswap response object
 */
async function tryWriteCache(data) {
  try {
    const cache = await import('./cache.js');
    await cache.writeCache(data);
  } catch {
    // cache module not ready or write failed — continue without caching
  }
}

/**
 * Normalise a raw Uniswap token entry into our standard shape.
 *
 * @param {{ address: string, symbol: string, decimals: number, name: string }} tok
 * @returns {{ symbol: string, contract: string, decimals: number, name: string }}
 */
function normalise(tok) {
  return {
    symbol:   tok.symbol,
    contract: getAddress(tok.address),   // EIP-55 checksum
    decimals: tok.decimals,
    name:     tok.name ?? tok.symbol,
  };
}

/**
 * Merge discovered tokens with the hardcoded fallback list for a chain.
 * Discovered entries take precedence over hardcoded entries when addresses match.
 * De-duplicates by lower-cased contract address.
 *
 * @param {object[]} discovered   - normalised tokens from Uniswap list
 * @param {object[]} hardcoded    - TOKEN_LISTS[chainName] entries
 * @returns {object[]}
 */
function mergeWithHardcoded(discovered, hardcoded) {
  const byAddr = new Map();

  // Seed with hardcoded entries first (lower priority)
  for (const tok of hardcoded) {
    byAddr.set(tok.contract.toLowerCase(), {
      ...tok,
      name: tok.name ?? tok.symbol,
    });
  }

  // Overwrite / add with discovered entries (higher priority)
  for (const tok of discovered) {
    byAddr.set(tok.contract.toLowerCase(), tok);
  }

  return [...byAddr.values()];
}

/**
 * Fetch the Uniswap token list, consult the disk cache first,
 * filter to the requested chain, and return a normalised list.
 *
 * Always resolves — never throws.
 * Returns the hardcoded fallback list on any error.
 *
 * @param {string} chainName  - one of 'ethereum' | 'polygon' | 'arbitrum' | 'base'
 * @returns {Promise<{ symbol: string, contract: string, decimals: number, name: string }[]>}
 */
export async function getTokenList(chainName) {
  // Return the in-process singleton when already resolved for this chain.
  if (_resolved.has(chainName)) {
    return _resolved.get(chainName);
  }

  const chainId = CHAIN_IDS[chainName];
  if (chainId === undefined) {
    process.stderr.write(`(unknown chainName "${chainName}" — falling back to hardcoded token list)\n`);
    return TOKEN_LISTS[chainName] ?? [];
  }

  const hardcoded = TOKEN_LISTS[chainName] ?? [];

  try {
    // ── 1. Try disk cache first ────────────────────────────────────────────────
    let rawData = await tryReadCache();

    // ── 2. Fetch from Uniswap if cache miss ───────────────────────────────────
    if (!rawData) {
      const res = await fetch(UNISWAP_TOKEN_LIST_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`Uniswap token list HTTP ${res.status}`);
      }
      rawData = await res.json();

      // Persist to disk cache (best-effort)
      await tryWriteCache(rawData);
    }

    // ── 3. Filter by chain ID ─────────────────────────────────────────────────
    const allTokens = rawData?.tokens ?? [];
    const discovered = allTokens
      .filter(tok => tok.chainId === chainId && tok.address)
      .map(normalise);

    // ── 4. Merge with hardcoded list, de-duplicate ────────────────────────────
    const merged = mergeWithHardcoded(discovered, hardcoded);

    // Cache in-process so subsequent calls within the same process are free.
    _resolved.set(chainName, merged);

    return merged;
  } catch (err) {
    process.stderr.write(`(falling back to hardcoded token list for ${chainName}: ${err?.message ?? err})\n`);

    const fallback = hardcoded.map(tok => ({
      ...tok,
      name: tok.name ?? tok.symbol,
    }));

    // Don't cache the fallback — next call should retry the network.
    return fallback;
  }
}
