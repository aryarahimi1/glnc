/**
 * src/chains/_evm.js
 *
 * Shared utilities for EVM-compatible chains.
 * Not exported as a chain adapter — used internally.
 */

import {
  createPublicClient,
  http,
  formatUnits,
  getAddress,
  isAddress,
} from 'viem';

// ─── Minimal ABI fragments ────────────────────────────────────────────────────

export const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
];

// ─── Token lists per chain ────────────────────────────────────────────────────

export const TOKEN_LISTS = {
  ethereum: [
    { symbol: 'USDC',   contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6  },
    { symbol: 'USDT',   contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6  },
    { symbol: 'DAI',    contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    { symbol: 'WETH',   contract: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    { symbol: 'WBTC',   contract: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8  },
    // Liquid staking tokens
    { symbol: 'stETH',  contract: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', decimals: 18 }, // Lido staked ETH
    { symbol: 'wstETH', contract: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', decimals: 18 }, // Lido wrapped stETH
    { symbol: 'rETH',   contract: '0xae78736Cd615f374D3085123A210448E74Fc6393', decimals: 18 }, // Rocket Pool ETH
    { symbol: 'cbETH',  contract: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', decimals: 18 }, // Coinbase staked ETH
    // DeFi governance & protocol tokens
    { symbol: 'AAVE',   contract: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18 }, // Aave governance
    { symbol: 'CRV',    contract: '0xD533a949740bb3306d119CC777fa900bA034cd52', decimals: 18 }, // Curve
    { symbol: 'LDO',    contract: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', decimals: 18 }, // Lido governance
    { symbol: 'MKR',    contract: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', decimals: 18 }, // Maker
    { symbol: 'SNX',    contract: '0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F', decimals: 18 }, // Synthetix
  ],
  polygon: [
    { symbol: 'USDC',   contract: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6  },
    { symbol: 'USDT',   contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6  },
    { symbol: 'WETH',   contract: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
    { symbol: 'WMATIC', contract: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18 },
  ],
  arbitrum: [
    { symbol: 'USDC',  contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6  },
    { symbol: 'USDT',  contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6  },
    { symbol: 'DAI',   contract: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    { symbol: 'WETH',  contract: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    { symbol: 'WBTC',  contract: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8  },
    { symbol: 'ARB',   contract: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
    { symbol: 'GMX',   contract: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', decimals: 18 },
  ],
  base: [
    { symbol: 'USDC',  contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6  },
    { symbol: 'DAI',   contract: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    { symbol: 'WETH',  contract: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'WELL',  contract: '0xA88594D404727625A9437C3f886C7643872296AE', decimals: 18 }, // Moonwell
  ],
  optimism: [
    { symbol: 'USDC',  contract: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6  }, // Circle-native USDC
    { symbol: 'USDC.e',contract: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', decimals: 6  }, // Bridged USDC
    { symbol: 'USDT',  contract: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6  },
    { symbol: 'DAI',   contract: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    { symbol: 'WETH',  contract: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'WBTC',  contract: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', decimals: 8  },
    { symbol: 'OP',    contract: '0x4200000000000000000000000000000000000042', decimals: 18 },
  ],
  // Linea and zkSync canonical token lists intentionally omitted until each
  // address is independently verified. With fail-closed semantics in
  // tokens/filter.js, the missing list means *no* symbol-keyed price is
  // applied on those chains, so a spoofed "USDC" cannot inherit a real price.
  // Real holdings on linea/zksync are surfaced as noPrice:true (still visible
  // via --show-unpriced). Add verified entries here to restore pricing.
};

// ─── In-memory token metadata cache ──────────────────────────────────────────
// key: `${chainId}:${contractAddress}`
const tokenMetaCache = new Map();

/**
 * Build a viem PublicClient for the given RPC URL.
 */
export function makeClient(rpcUrl, chain) {
  return createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10_000 }) });
}

// Maximum number of balanceOf calls per multicall batch.
// Keeps individual multicall payloads within typical RPC node limits (~100-500).
const MULTICALL_CHUNK_SIZE = 100;

/**
 * Split an array into consecutive chunks of at most `size` elements.
 *
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Read ERC-20 balanceOf for a list of token descriptors.
 * Splits large token lists into chunks of MULTICALL_CHUNK_SIZE to avoid
 * "execution reverted" errors on RPC nodes that cap multicall batch size.
 * Falls back gracefully to sequential individual calls if multicall is unavailable.
 *
 * @param {ReturnType<typeof makeClient>} client
 * @param {string} address   - checksummed owner address
 * @param {{ symbol, contract, decimals }[]} tokens
 * @returns {Promise<{ symbol, amount, decimals, contract }[]>}
 */
export async function fetchERC20Balances(client, address, tokens) {
  if (tokens.length === 0) return [];

  const tokenChunks = chunkArray(tokens, MULTICALL_CHUNK_SIZE);

  // Run all chunks concurrently; each chunk is one multicall request.
  const chunkResults = await Promise.all(
    tokenChunks.map(async (chunk) => {
      const calls = chunk.map(tok => ({
        address: tok.contract,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      }));

      let results;
      try {
        results = await client.multicall({ contracts: calls, allowFailure: true });
      } catch {
        // multicall not available on this node — fall back to sequential reads
        results = await Promise.all(
          calls.map(async (c) => {
            try {
              const result = await client.readContract({
                address: c.address,
                abi: ERC20_ABI,
                functionName: 'balanceOf',
                args: c.args,
              });
              return { result, status: 'success' };
            } catch (e) {
              return { error: e, status: 'failure' };
            }
          })
        );
      }

      // Pair each result back with its token descriptor and collect non-zero balances.
      const balances = [];
      for (let i = 0; i < chunk.length; i++) {
        const res = results[i];
        if (res.status === 'success' && res.result > 0n) {
          const tok = chunk[i];
          balances.push({
            symbol:   tok.symbol,
            amount:   formatUnits(res.result, tok.decimals),
            decimals: tok.decimals,
            contract: tok.contract,
          });
        }
      }
      return balances;
    })
  );

  // Flatten results from all chunks into a single array.
  return chunkResults.flat();
}

/**
 * Fetch on-chain symbol + decimals for a contract; uses in-memory cache.
 */
export async function fetchTokenMeta(client, contractAddress, chainKey) {
  const cacheKey = `${chainKey}:${contractAddress.toLowerCase()}`;
  if (tokenMetaCache.has(cacheKey)) return tokenMetaCache.get(cacheKey);

  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: contractAddress, abi: ERC20_ABI, functionName: 'symbol' }),
      client.readContract({ address: contractAddress, abi: ERC20_ABI, functionName: 'decimals' }),
    ]);
    const meta = { symbol, decimals };
    tokenMetaCache.set(cacheKey, meta);
    return meta;
  } catch {
    return null;
  }
}

/**
 * Build the standard balance response shape.
 */
export function buildBalanceResponse(chainName, nativeSymbol, nativeAmount, nativeDecimals, tokens) {
  return {
    chain:  chainName,
    native: {
      symbol:   nativeSymbol,
      amount:   nativeAmount,
      decimals: nativeDecimals,
    },
    tokens,
    error: null,
  };
}

/**
 * Build an error response shape.
 */
export function buildErrorResponse(chainName, message) {
  return { chain: chainName, native: null, tokens: [], error: message };
}

export { formatUnits, getAddress, isAddress };
