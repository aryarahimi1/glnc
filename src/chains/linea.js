/**
 * src/chains/linea.js
 *
 * Linea Mainnet — gas-only adapter (Consensys ZK-EVM L2).
 */

import { linea } from 'viem/chains';

export const name = 'linea';
export const RPC_URL = 'https://linea-rpc.publicnode.com';
export const viemChain = linea;
export const nativeSymbol = 'ETH';
