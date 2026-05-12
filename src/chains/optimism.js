/**
 * src/chains/optimism.js
 *
 * Optimism Mainnet chain adapter (OP Stack L2).
 *
 * Balance + tx via viem's standard JSON-RPC; OP-Stack chains share Ethereum's
 * tx shape. Token list is not yet curated for Optimism — getTokenList returns
 * an empty array until a curated list lands, so only native ETH is reported.
 *
 * Exports:
 *   name          — 'optimism'
 *   getBalances(address)
 *   getTransaction(txHash)
 */

import { optimism } from 'viem/chains';
import {
  makeClient,
  fetchERC20Balances,
  buildBalanceResponse,
  buildErrorResponse,
  formatUnits,
  getAddress,
} from './_evm.js';

export const name = 'optimism';

export const RPC_URL = 'https://optimism-rpc.publicnode.com';
export const viemChain = optimism;
export const nativeSymbol = 'ETH';

function getClient() {
  return makeClient(RPC_URL, optimism);
}

// Lazy singleton — resolved once per process, reused on every subsequent call.
let _tokenList = null;
async function resolveTokenList() {
  if (_tokenList) return _tokenList;
  const { getTokenList } = await import('../tokens/index.js');
  _tokenList = await getTokenList('optimism');
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
