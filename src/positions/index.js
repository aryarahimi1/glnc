/**
 * src/positions/index.js
 *
 * Orchestration layer for DeFi position queries.
 * Runs Aave and Uniswap V3 queries in parallel across all requested chains
 * and assembles a unified result object keyed by chain name.
 *
 * Exports:
 *   getPositions(address, chains) → Promise<PositionsResult>
 */

import { getAavePositions }      from './aave.js';
import { getUniswapV3Positions } from './uniswap.js';

/**
 * @typedef {{
 *   aave?:      import('./aave.js').AaveResult,
 *   uniswapV3?: Array<import('./uniswap.js').UniswapPosition>,
 *   error?:     string,
 * }} ChainPositions
 *
 * @typedef {Record<string, ChainPositions>} PositionsResult
 */

/**
 * Fetch DeFi positions for an EVM address across one or more chains.
 *
 * All chain × protocol queries are launched concurrently via Promise.allSettled
 * so a single slow or failing RPC cannot block the others.
 *
 * Only chains/protocols where hasPosition === true are included in the returned
 * object — chains with no activity are omitted to keep the output tidy.
 *
 * Never throws.
 *
 * @param {string}   address  — checksummed EVM address
 * @param {string[]} chains   — subset of ['ethereum', 'polygon', 'arbitrum', 'base']
 * @returns {Promise<PositionsResult>}
 */
export async function getPositions(address, chains) {
  /** @type {PositionsResult} */
  const result = {};

  // Build one task per chain × protocol combination
  const tasks = chains.flatMap(chain => [
    // ── Aave V3 ───────────────────────────────────────────────────────────────
    {
      chain,
      protocol: 'aave',
      fn: () => getAavePositions(address, chain),
    },
    // ── Uniswap V3 ───────────────────────────────────────────────────────────
    {
      chain,
      protocol: 'uniswap',
      fn: () => getUniswapV3Positions(address, chain),
    },
  ]);

  const settled = await Promise.allSettled(tasks.map(t => t.fn()));

  // Assemble results into the output map
  for (let i = 0; i < tasks.length; i++) {
    const { chain, protocol } = tasks[i];
    const outcome = settled[i];

    if (!result[chain]) result[chain] = {};

    if (outcome.status === 'rejected') {
      // Promise was rejected (should not happen — both helpers wrap in try/catch,
      // but guard defensively)
      const errMsg = outcome.reason?.message ?? String(outcome.reason);
      if (protocol === 'aave') {
        result[chain].aave = { hasPosition: false, error: errMsg };
      } else {
        result[chain].uniswapV3 = [];
      }
      continue;
    }

    const data = outcome.value;

    if (protocol === 'aave') {
      if (data.hasPosition) {
        result[chain].aave = data;
      }
      // If there's an error but no position, surface it anyway so the user
      // knows the query failed rather than just seeing silence.
      if (!data.hasPosition && data.error) {
        result[chain].aave = data;
      }
    } else {
      // Uniswap V3: render.js expects chainPositions.uniswapV3 to be an array
      // of position objects (or absent/empty when no positions exist).
      if (data.hasPosition && data.positions?.length > 0) {
        // Transform to the shape renderPositions() expects:
        // [{ pair, feeTier, hasLiquidity, tokenId, ... }]
        result[chain].uniswapV3 = data.positions.map(p => ({
          tokenId:      p.tokenId,
          pair:         `${p.token0Symbol}/${p.token1Symbol}`,
          feeTier:      p.feeStr.replace('%', ''),  // '0.3' from '0.3%'
          fee:          p.fee,
          feeStr:       p.feeStr,
          hasLiquidity: p.hasLiquidity,
          liquidity:    p.liquidity,
          token0Symbol: p.token0Symbol,
          token1Symbol: p.token1Symbol,
        }));
      }
    }
  }

  // Prune chains that have no active positions at all
  for (const chain of Object.keys(result)) {
    const cp = result[chain];
    const hasAave = cp.aave?.hasPosition === true;
    // An error-only aave entry (no position) can be pruned too
    const hasAaveError = cp.aave && !cp.aave.hasPosition && cp.aave.error;
    const hasUni = Array.isArray(cp.uniswapV3) && cp.uniswapV3.length > 0;

    if (!hasAave && !hasUni && !hasAaveError) {
      delete result[chain];
    } else if (!hasAave && !hasAaveError) {
      delete result[chain].aave;
    }
  }

  return result;
}
