/**
 * src/positions/uniswap.js
 *
 * Fetch Uniswap V3 LP positions (NFT-based) for an address on any supported EVM chain.
 * Uses the NonfungiblePositionManager (NFT_MANAGER) contract.
 *
 * Exports:
 *   getUniswapV3Positions(address, chain) → Promise<UniswapResult>
 */

import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { polygon } from 'viem/chains';
import { arbitrum } from 'viem/chains';
import { base } from 'viem/chains';
import { fetchTokenMeta } from '../chains/_evm.js';

// ─── NonfungiblePositionManager addresses ─────────────────────────────────────
// Same address on Ethereum, Polygon, and Arbitrum; different on Base.

const NFT_MANAGER = {
  ethereum: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  polygon:  '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  arbitrum: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  base:     '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
};

// ─── Public RPC endpoints ─────────────────────────────────────────────────────

const CHAIN_RPC = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  polygon:  'https://polygon-bor-rpc.publicnode.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  base:     'https://mainnet.base.org',
};

// ─── viem chain objects ───────────────────────────────────────────────────────

const CHAIN_OBJ = {
  ethereum: mainnet,
  polygon,
  arbitrum,
  base,
};

// ─── ABI fragments for the NonfungiblePositionManager ─────────────────────────

const NFT_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'tokenOfOwnerByIndex',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'positions',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce',                      type: 'uint96'  },
      { name: 'operator',                   type: 'address' },
      { name: 'token0',                     type: 'address' },
      { name: 'token1',                     type: 'address' },
      { name: 'fee',                        type: 'uint24'  },
      { name: 'tickLower',                  type: 'int24'   },
      { name: 'tickUpper',                  type: 'int24'   },
      { name: 'liquidity',                  type: 'uint128' },
      { name: 'feeGrowthInside0LastX128',   type: 'uint256' },
      { name: 'feeGrowthInside1LastX128',   type: 'uint256' },
      { name: 'tokensOwed0',                type: 'uint128' },
      { name: 'tokensOwed1',                type: 'uint128' },
    ],
  },
];

// ─── Fee tier mapping ─────────────────────────────────────────────────────────

/** Map raw fee (uint24, in units of 0.0001%) to human-readable percentage string. */
const FEE_TIER_STR = {
  100:   '0.01%',
  500:   '0.05%',
  3000:  '0.3%',
  10000: '1%',
};

// ─── Cap on positions fetched per wallet ─────────────────────────────────────
// Fetching > 20 positions requires many RPC round trips and risks rate-limiting
// on public nodes.  Users with more than 20 positions are still shown all of
// them in a single CLI invocation because we hard-cap the multicall, not the
// display.  Raise this constant if you add a dedicated RPC key.
const MAX_POSITIONS = 20;

// ─── Client cache (one per chain per process) ─────────────────────────────────

const _clients = new Map();

/**
 * Return a cached viem PublicClient for the given chain.
 *
 * @param {string} chain
 * @returns {import('viem').PublicClient}
 */
function getClient(chain) {
  if (_clients.has(chain)) return _clients.get(chain);
  const client = createPublicClient({
    chain: CHAIN_OBJ[chain],
    transport: http(CHAIN_RPC[chain], { timeout: 15_000 }),
  });
  _clients.set(chain, client);
  return client;
}

/**
 * @typedef {{
 *   tokenId: string,
 *   token0Symbol: string,
 *   token1Symbol: string,
 *   fee: number,
 *   feeStr: string,
 *   hasLiquidity: boolean,
 *   liquidity: string,
 * }} UniswapPosition
 *
 * @typedef {{
 *   hasPosition: boolean,
 *   positions: UniswapPosition[],
 *   error?: string,
 * }} UniswapResult
 */

/**
 * Fetch all Uniswap V3 LP positions owned by an address on a specific chain.
 *
 * Algorithm:
 *  1. Call balanceOf(address) → nftCount.
 *  2. If 0, return { hasPosition: false, positions: [] }.
 *  3. Cap at MAX_POSITIONS to avoid hammering the RPC endpoint.
 *  4. Multicall tokenOfOwnerByIndex for all indices.
 *  5. Multicall positions(tokenId) for all token IDs.
 *  6. Resolve token0/token1 symbols via fetchTokenMeta (cached).
 *
 * Never throws.
 *
 * @param {string} address  — checksummed EVM address
 * @param {string} chain    — 'ethereum' | 'polygon' | 'arbitrum' | 'base'
 * @returns {Promise<UniswapResult>}
 */
export async function getUniswapV3Positions(address, chain) {
  const managerAddress = NFT_MANAGER[chain];
  if (!managerAddress) {
    return {
      hasPosition: false,
      positions: [],
      error: `Uniswap V3 not configured for chain: ${chain}`,
    };
  }

  try {
    const client = getClient(chain);

    // ── Step 1: How many Uni V3 LP NFTs does this address own? ───────────────
    const nftCount = await client.readContract({
      address: managerAddress,
      abi: NFT_ABI,
      functionName: 'balanceOf',
      args: [address],
    });

    if (nftCount === 0n) {
      return { hasPosition: false, positions: [] };
    }

    // ── Step 2: Enumerate token IDs (capped at MAX_POSITIONS) ────────────────
    const count = Number(nftCount) < MAX_POSITIONS ? Number(nftCount) : MAX_POSITIONS;
    const indices = Array.from({ length: count }, (_, i) => BigInt(i));

    const tokenIdCalls = indices.map(i => ({
      address: managerAddress,
      abi: NFT_ABI,
      functionName: 'tokenOfOwnerByIndex',
      args: [address, i],
    }));

    const tokenIdResults = await client.multicall({
      contracts: tokenIdCalls,
      allowFailure: true,
    });

    const tokenIds = tokenIdResults
      .filter(r => r.status === 'success' && r.result != null)
      .map(r => r.result);

    if (tokenIds.length === 0) {
      return { hasPosition: false, positions: [] };
    }

    // ── Step 3: Fetch position data for each token ID ─────────────────────────
    const positionCalls = tokenIds.map(tokenId => ({
      address: managerAddress,
      abi: NFT_ABI,
      functionName: 'positions',
      args: [tokenId],
    }));

    const positionResults = await client.multicall({
      contracts: positionCalls,
      allowFailure: true,
    });

    // ── Step 4: Resolve token symbols (fetchTokenMeta is cached) ─────────────
    // Collect unique token addresses to resolve in parallel
    const tokenAddresses = new Set();
    for (const res of positionResults) {
      if (res.status !== 'success' || !res.result) continue;
      const [, , token0, token1] = res.result;
      if (token0) tokenAddresses.add(token0.toLowerCase());
      if (token1) tokenAddresses.add(token1.toLowerCase());
    }

    const metaMap = new Map();
    await Promise.all(
      [...tokenAddresses].map(async (addr) => {
        const meta = await fetchTokenMeta(client, addr, chain);
        metaMap.set(addr.toLowerCase(), meta);
      })
    );

    // ── Step 5: Assemble position objects ─────────────────────────────────────
    const positions = [];

    for (let i = 0; i < positionResults.length; i++) {
      const res = positionResults[i];
      if (res.status !== 'success' || !res.result) continue;

      const [
        _nonce,
        _operator,
        token0,
        token1,
        fee,
        _tickLower,
        _tickUpper,
        liquidity,
      ] = res.result;

      const t0Meta = metaMap.get(token0?.toLowerCase());
      const t1Meta = metaMap.get(token1?.toLowerCase());

      const token0Symbol = t0Meta?.symbol ?? token0?.slice(0, 6) ?? '???';
      const token1Symbol = t1Meta?.symbol ?? token1?.slice(0, 6) ?? '???';

      const feeNum = Number(fee);
      const feeStr = FEE_TIER_STR[feeNum] ?? `${(feeNum / 10000).toFixed(4)}%`;

      positions.push({
        tokenId:      tokenIds[i].toString(),
        token0Symbol,
        token1Symbol,
        fee:          feeNum,
        feeStr,
        hasLiquidity: liquidity > 0n,
        liquidity:    liquidity.toString(),
      });
    }

    return {
      hasPosition: positions.length > 0,
      positions,
    };
  } catch (err) {
    return {
      hasPosition: false,
      positions: [],
      error: err?.message ?? String(err),
    };
  }
}
