/**
 * src/chains/optimism.js
 *
 * Optimism Mainnet — gas-only adapter (OP Stack L2).
 *
 * Exports the minimal config needed by src/gas.js. Balance / tx support not
 * yet implemented for this chain; add getBalances() and getTransaction()
 * here when extending those features.
 */

import { optimism } from 'viem/chains';

export const name = 'optimism';
export const RPC_URL = 'https://optimism-rpc.publicnode.com';
export const viemChain = optimism;
export const nativeSymbol = 'ETH';
