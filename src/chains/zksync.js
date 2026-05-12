/**
 * src/chains/zksync.js
 *
 * zkSync Era Mainnet chain adapter (ZK rollup).
 *
 * Balance via viem's standard JSON-RPC works fine. Transactions, however, use
 * a non-standard format (custom fields like `paymaster`, `customData`) — if
 * viem's getTransaction throws on these, we surface the error rather than
 * adding zksync-specific decoding here. Token list is not yet curated for
 * zkSync — getTokenList returns an empty array, so only native ETH is
 * reported.
 *
 * Note: zkSync Era's fee model differs from vanilla EIP-1559. eth_feeHistory
 * may return limited or non-standard data; the gas fetcher's fallback path
 * (eth_getBlockByNumber + eth_maxPriorityFeePerGas) handles this gracefully.
 *
 * Exports:
 *   name          — 'zksync'
 *   getBalances(address)
 *   getTransaction(txHash)
 */

import { zksync } from 'viem/chains';
import {
  makeClient,
  fetchERC20Balances,
  buildBalanceResponse,
  buildErrorResponse,
  formatUnits,
  getAddress,
} from './_evm.js';

export const name = 'zksync';

export const RPC_URL = 'https://mainnet.era.zksync.io';
export const viemChain = zksync;
export const nativeSymbol = 'ETH';

function getClient() {
  return makeClient(RPC_URL, zksync);
}

// Lazy singleton — resolved once per process, reused on every subsequent call.
let _tokenList = null;
async function resolveTokenList() {
  if (_tokenList) return _tokenList;
  const { getTokenList } = await import('../tokens/index.js');
  _tokenList = await getTokenList('zksync');
  return _tokenList;
}

/**
 * @param {string} address  - 0x-prefixed EVM address
 * @returns {Promise<{
 *   chain: string,
 *   native: { symbol: string, amount: string, decimals: number },
 *   tokens: { symbol: string, amount: string, decimals: number, contract: string }[],
 *   error: string | null
 * }>}
 */
export async function getBalances(address) {
  try {
    const checksummed = getAddress(address);
    const client = getClient();

    const tokenList = await resolveTokenList();
    const [nativeWei, tokens] = await Promise.all([
      client.getBalance({ address: checksummed }),
      fetchERC20Balances(client, checksummed, tokenList),
    ]);

    return buildBalanceResponse(
      name,
      'ETH',
      formatUnits(nativeWei, 18),
      18,
      tokens,
    );
  } catch (err) {
    return buildErrorResponse(name, err?.message ?? String(err));
  }
}

/**
 * @param {string} txHash
 * @returns {Promise<{ tx: object, receipt: object } | null>}
 */
export async function getTransaction(txHash) {
  try {
    const client = getClient();
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
    ]);
    return { tx, receipt };
  } catch (err) {
    return { tx: null, receipt: null, error: err?.message ?? String(err) };
  }
}
