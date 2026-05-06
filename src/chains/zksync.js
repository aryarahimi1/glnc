/**
 * src/chains/zksync.js
 *
 * zkSync Era Mainnet — gas-only adapter (ZK rollup).
 *
 * Note: zkSync Era's fee model differs from vanilla EIP-1559. eth_feeHistory
 * may return limited or non-standard data; the gas fetcher's fallback path
 * (eth_getBlockByNumber + eth_maxPriorityFeePerGas) handles this gracefully.
 */

import { zksync } from 'viem/chains';

export const name = 'zksync';
export const RPC_URL = 'https://mainnet.era.zksync.io';
export const viemChain = zksync;
export const nativeSymbol = 'ETH';
