/**
 * src/chains/linea.js
 *
 * Linea Mainnet chain adapter (Consensys ZK-EVM L2).
 *
 * Balance + tx via viem's standard JSON-RPC; Linea is EVM-equivalent and
 * shares Ethereum's tx shape. ERC-20 pricing is intentionally fail-closed
 * here: canonical Linea token addresses have not yet been independently
 * verified, so no symbol-keyed price is applied (spoofed "USDC" cannot
 * inherit a real price). Holdings still surface as noPrice — pass
 * --show-unpriced to see them. Discovered tokens from the Uniswap default
 * list are still loaded via tokens/index.js.
 *
 * Exports:
 *   name          — 'linea'
 *   getBalances(address)
 *   getTransaction(txHash)
 */

import { linea } from 'viem/chains';
import {
  makeClient,
  fetchERC20Balances,
  buildBalanceResponse,
  buildErrorResponse,
  formatUnits,
  getAddress,
} from './_evm.js';

export const name = 'linea';

export const RPC_URL = 'https://linea-rpc.publicnode.com';
export const viemChain = linea;
export const nativeSymbol = 'ETH';

function getClient() {
  return makeClient(RPC_URL, linea);
}

// Lazy singleton — resolved once per process, reused on every subsequent call.
let _tokenList = null;
async function resolveTokenList() {
  if (_tokenList) return _tokenList;
  const { getTokenList } = await import('../tokens/index.js');
  _tokenList = await getTokenList('linea');
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
