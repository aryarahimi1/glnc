/**
 * src/chains/arbitrum.js
 *
 * Arbitrum One chain adapter.
 *
 * Exports:
 *   name          — 'arbitrum'
 *   getBalances(address)
 *   getTransaction(txHash)
 */

import { arbitrum } from 'viem/chains';
import {
  makeClient,
  fetchERC20Balances,
  buildBalanceResponse,
  buildErrorResponse,
  formatUnits,
  getAddress,
} from './_evm.js';

export const name = 'arbitrum';

export const RPC_URL = 'https://arb1.arbitrum.io/rpc';
export const viemChain = arbitrum;
export const nativeSymbol = 'ETH';

function getClient() {
  return makeClient(RPC_URL, arbitrum);
}

// Lazy singleton — resolved once per process, reused on every subsequent call.
let _tokenList = null;
async function resolveTokenList() {
  if (_tokenList) return _tokenList;
  const { getTokenList } = await import('../tokens/index.js');
  _tokenList = await getTokenList('arbitrum');
  return _tokenList;
}

/**
 * Fetch native ETH balance + top ERC-20 balances for an address.
 *
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
