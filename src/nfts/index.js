/**
 * src/nfts/index.js
 *
 * Orchestration layer for NFT holdings queries.
 * Runs Reservoir queries in parallel across all requested EVM chains and
 * assembles a unified result object keyed by chain name.
 *
 * Caveats:
 *   - Reservoir's free tier covers EVM chains only.
 *   - Floor prices update every few minutes; treat figures as indicative.
 *   - We do NOT de-duplicate cross-chain spam: a collection with the same
 *     name on multiple chains will appear once per chain.
 *
 * Exports:
 *   getNftHoldings(address, chains, opts) → Promise<NftsResult>
 */

import { getReservoirHoldings } from './reservoir.js';

/**
 * @typedef {{
 *   collections: Array<object>,
 *   totalCount: number,
 *   totalNative: number|null,
 *   totalUsd: number|null,
 *   nativeSymbol: string,
 *   error?: string,
 *   truncated?: boolean,
 * }} ChainNfts
 *
 * @typedef {Record<string, ChainNfts>} NftsResult
 */

/**
 * Fetch NFT holdings for an EVM address across one or more chains.
 *
 * Runs all chain queries concurrently via Promise.allSettled so one slow
 * chain cannot block the others.  Never throws.
 *
 * Only chains where collections.length > 0 OR there's an error are included
 * in the returned object — empty chains are pruned to keep the renderer
 * logic simple ("if nfts[chain] exists, render it").
 *
 * @param {string}   address  EVM 0x-prefixed address
 * @param {string[]} chains   subset of ['ethereum', 'polygon', 'arbitrum', 'base', 'optimism']
 * @param {{ apiKey?: string, onWarn?: (msg: string) => void }} [opts]
 * @returns {Promise<NftsResult>}
 */
export async function getNftHoldings(address, chains, opts = {}) {
  /** @type {NftsResult} */
  const result = {};

  const list   = Array.isArray(chains) ? chains : [];
  const settled = await Promise.allSettled(
    list.map(chain => getReservoirHoldings(chain, address, opts)),
  );

  for (let i = 0; i < list.length; i++) {
    const chain   = list[i];
    const outcome = settled[i];

    if (outcome.status === 'rejected') {
      // Defensive: getReservoirHoldings traps its own errors, but guard anyway.
      result[chain] = {
        collections:  [],
        totalCount:   0,
        totalNative:  null,
        totalUsd:     null,
        nativeSymbol: '',
        error:        outcome.reason?.message ?? String(outcome.reason),
      };
      continue;
    }

    const data = outcome.value;
    const entry = {
      collections:  data.collections,
      totalCount:   data.totalCount,
      totalNative:  data.totalNative,
      totalUsd:     data.totalUsd,
      nativeSymbol: data.nativeSymbol,
    };
    if (data.error)     entry.error     = data.error;
    if (data.truncated) entry.truncated = true;

    // Prune empty, error-free chains so the renderer can skip a chain by
    // simple key presence.
    if (entry.collections.length === 0 && !entry.error) continue;

    result[chain] = entry;
  }

  return result;
}
