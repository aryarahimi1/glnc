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
 *   getBalances({ address, rpcQuorum? })
 *   getTransaction({ hash, rpcQuorum? })
 */

import { linea } from 'viem/chains';
import {
  fetchERC20Balances,
  buildBalanceResponse,
  buildErrorResponse,
  formatUnits,
  getAddress,
  queryQuorum,
} from './_evm.js';

export const name = 'linea';

// Curated 2026-05 against live availability; no API key required.
export const RPC_URLS = [
  'https://linea-rpc.publicnode.com',
  'https://rpc.linea.build',
  'https://linea.drpc.org',
];
export const viemChain = linea;
export const nativeSymbol = 'ETH';

// Lazy singleton — resolved once per process, reused on every subsequent call.
let _tokenList = null;
async function resolveTokenList() {
  if (_tokenList) return _tokenList;
  const { getTokenList } = await import('../tokens/index.js');
  _tokenList = await getTokenList('linea');
  return _tokenList;
}

/**
 * Normalize a balance exec result to a stable comparison key for queryQuorum.
 *
 * @param {{ nativeWei: bigint, tokens: Array<{contract: string, amount: string}> }} v
 * @returns {string}
 */
function normalizeBalances(v) {
  const nativeKey = v.nativeWei.toString();
  const tokensKey = v.tokens
    .map(t => `${t.contract.toLowerCase()}:${t.amount}`)
    .sort()
    .join(',');
  return `${nativeKey}|${tokensKey}`;
}

/**
 * Normalize a tx exec result to a stable comparison key for queryQuorum.
 *
 * @param {{ tx: object, receipt: object }} v
 * @returns {string}
 */
function normalizeTx(v) {
  const hash   = v.receipt?.transactionHash ?? v.tx?.hash ?? '';
  const status = v.receipt?.status ?? '';
  const block  = v.receipt?.blockNumber != null ? String(v.receipt.blockNumber) : '';
  return `${hash}:${status}:${block}`;
}

/**
 * @param {{ address: string, rpcQuorum?: 'any'|'majority'|'all' }} opts
 * @returns {Promise<{
 *   chain: string,
 *   native: { symbol: string, amount: string, decimals: number },
 *   tokens: { symbol: string, amount: string, decimals: number, contract: string }[],
 *   error: string | null
 * }>}
 */
export async function getBalances({ address, rpcQuorum = 'any' } = {}) {
  try {
    const checksummed = getAddress(address);
    const tokenList = await resolveTokenList();

    const { value, source, agreement, disagreements, sources } = await queryQuorum({
      urls: RPC_URLS,
      viemChain,
      exec: async (client) => {
        const [nativeWei, tokens, blockNumber] = await Promise.all([
          client.getBalance({ address: checksummed }),
          fetchERC20Balances(client, checksummed, tokenList),
          client.getBlockNumber(),
        ]);
        return { nativeWei, tokens, blockNumber };
      },
      mode: rpcQuorum,
      normalize: normalizeBalances,
    });

    const { nativeWei, tokens, blockNumber } = value;

    const response = {
      ...buildBalanceResponse(name, 'ETH', formatUnits(nativeWei, 18), 18, tokens),
      source,
      blockNumber: String(blockNumber),
    };

    if (rpcQuorum !== 'any') {
      response.quorum = { agreement, disagreements, sources };
    }

    return response;
  } catch (err) {
    return buildErrorResponse(name, err?.message ?? String(err));
  }
}

/**
 * @param {{ hash: string, rpcQuorum?: 'any'|'majority'|'all' }} opts
 * @returns {Promise<{ tx: object, receipt: object } | null>}
 */
export async function getTransaction({ hash, rpcQuorum = 'any' } = {}) {
  try {
    const { value, source, agreement, disagreements, sources } = await queryQuorum({
      urls: RPC_URLS,
      viemChain,
      exec: async (client) => {
        const [tx, receipt] = await Promise.all([
          client.getTransaction({ hash }),
          client.getTransactionReceipt({ hash }),
        ]);
        return { tx, receipt };
      },
      mode: rpcQuorum,
      normalize: normalizeTx,
    });

    const response = {
      tx:          value.tx,
      receipt:     value.receipt,
      source,
      blockNumber: value.tx?.blockNumber != null ? String(value.tx.blockNumber) : null,
    };

    if (rpcQuorum !== 'any') {
      response.quorum = { agreement, disagreements, sources };
    }

    return response;
  } catch (err) {
    return { tx: null, receipt: null, error: err?.message ?? String(err) };
  }
}
