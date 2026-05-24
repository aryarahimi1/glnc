/**
 * src/chains/ethereum.js
 *
 * Ethereum Mainnet chain adapter.
 *
 * deps (add to package.json):
 *   "viem": "^2.0.0"
 *
 * Exports:
 *   name          — 'ethereum'
 *   getBalances({ address, rpcQuorum? })   — returns standard balance shape
 *   getTransaction({ hash, rpcQuorum? })   — returns raw tx + receipt fields
 */

import { mainnet } from 'viem/chains';
import {
  fetchERC20Balances,
  buildBalanceResponse,
  buildErrorResponse,
  formatUnits,
  getAddress,
  queryQuorum,
} from './_evm.js';

export const name = 'ethereum';

// Curated 2026-05 against live availability; no API key required.
export const RPC_URLS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://eth.merkle.io',
];
export const viemChain = mainnet;
export const nativeSymbol = 'ETH';

// Lazy singleton — resolved once per process, reused on every subsequent call.
let _tokenList = null;
async function resolveTokenList() {
  if (_tokenList) return _tokenList;
  const { getTokenList } = await import('../tokens/index.js');
  _tokenList = await getTokenList('ethereum');
  return _tokenList;
}

/**
 * Normalize a balance exec result to a stable comparison key for queryQuorum.
 * Compares native wei + per-contract token amounts (sorted by contract address).
 * Block number is intentionally excluded — it can differ across providers.
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
 * Compares hash + status + blockNumber. Gas oracle fields (effectiveGasPrice
 * etc.) are deliberately excluded — they can differ across providers.
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
 * Fetch native ETH balance + top ERC-20 balances for an address.
 *
 * @param {{ address: string, rpcQuorum?: 'any'|'majority'|'all' }} opts
 * @returns {Promise<{
 *   chain: string,
 *   native: { symbol: string, amount: string, decimals: number },
 *   tokens: { symbol: string, amount: string, decimals: number, contract: string }[],
 *   error: string | null,
 *   source: string,
 *   blockNumber: string,
 *   quorum?: { agreement: string, disagreements: Array<object>, sources: Array<object> },
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
 * Fetch a transaction by hash — returns raw viem transaction + receipt.
 * The decoder layer (src/decoders/index.js) calls this to get raw data.
 *
 * @param {{ hash: string, rpcQuorum?: 'any'|'majority'|'all' }} opts
 * @returns {Promise<{ tx: object, receipt: object, source: string, blockNumber: string|null } | null>}
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
