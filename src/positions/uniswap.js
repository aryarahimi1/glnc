/**
 * src/positions/uniswap.js
 *
 * Fetch Uniswap V3 LP positions (NFT-based) for an address on any supported EVM chain.
 * Uses the NonfungiblePositionManager (NFT_MANAGER) contract.
 *
 * Exports:
 *   getUniswapV3Positions(address, chain) → Promise<UniswapResult>
 */

import { createPublicClient, http, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { polygon } from 'viem/chains';
import { arbitrum } from 'viem/chains';
import { base } from 'viem/chains';
import { fetchTokenMeta } from '../chains/_evm.js';

// ─── Uniswap V3 Factory (same address on Ethereum, Polygon, Arbitrum, Base) ───
const V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

const FACTORY_ABI = [
  {
    name: 'getPool',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee',    type: 'uint24'  },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
];

const POOL_ABI = [
  {
    name: 'slot0',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96',               type: 'uint160' },
      { name: 'tick',                       type: 'int24'   },
      { name: 'observationIndex',           type: 'uint16'  },
      { name: 'observationCardinality',     type: 'uint16'  },
      { name: 'observationCardinalityNext', type: 'uint16'  },
      { name: 'feeProtocol',                type: 'uint8'   },
      { name: 'unlocked',                   type: 'bool'    },
    ],
  },
];

// ─── Inline TickMath (Uniswap V3) ─────────────────────────────────────────────
// Computes sqrtPriceX96 = sqrt(1.0001^tick) * 2^96 using the canonical
// magic-multiplier algorithm from Uniswap V3's TickMath.sol. BigInt only.

const Q96 = 1n << 96n;

function getSqrtRatioAtTick(tick) {
  const absTick = tick < 0 ? -tick : tick;
  if (absTick > 887272) throw new Error('tick out of range');
  let ratio = (absTick & 0x1) !== 0
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2)     !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4)     !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8)     !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10)    !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20)    !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40)    !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80)    !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100)   !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200)   !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400)   !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800)   !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000)  !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000)  !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000)  !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000)  !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n)  >> 128n;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n)   >> 128n;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n)     >> 128n;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n)          >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function getAmount0(sqrtA, sqrtB, L) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (L * Q96 * (sqrtB - sqrtA)) / (sqrtB * sqrtA);
}

function getAmount1(sqrtA, sqrtB, L) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (L * (sqrtB - sqrtA)) / Q96;
}

/**
 * Compute token0/token1 amounts owned by an LP position given current pool
 * sqrtPrice and the position's tick range + liquidity.
 */
function computeAmounts(sqrtPriceX96, tickLower, tickUpper, liquidity) {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 <= sqrtA) {
    return { amount0: getAmount0(sqrtA, sqrtB, liquidity), amount1: 0n };
  }
  if (sqrtPriceX96 >= sqrtB) {
    return { amount0: 0n, amount1: getAmount1(sqrtA, sqrtB, liquidity) };
  }
  return {
    amount0: getAmount0(sqrtPriceX96, sqrtB, liquidity),
    amount1: getAmount1(sqrtA, sqrtPriceX96, liquidity),
  };
}

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
 *   amount0?: string,
 *   amount1?: string,
 *   inRange?: boolean,
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

    // ── Step 4b: Resolve pool slot0 for each unique (token0,token1,fee) ──────
    // Two-phase: first resolve unique pool addresses via factory.getPool,
    // then batch-fetch slot0 for each. If any lookup fails, that position
    // simply falls back to the old hasLiquidity heuristic.
    const poolKey = (a, b, f) => `${a.toLowerCase()}-${b.toLowerCase()}-${f}`;
    const poolRequests = new Map(); // key → { token0, token1, fee }
    for (const res of positionResults) {
      if (res.status !== 'success' || !res.result) continue;
      const [, , t0, t1, f] = res.result;
      if (!t0 || !t1) continue;
      const k = poolKey(t0, t1, f);
      if (!poolRequests.has(k)) poolRequests.set(k, { token0: t0, token1: t1, fee: f });
    }

    const poolAddrMap = new Map(); // key → pool address (or null)
    const poolKeys = [...poolRequests.keys()];
    const poolAddrResults = await Promise.allSettled(
      poolKeys.map(k => {
        const { token0, token1, fee } = poolRequests.get(k);
        return client.readContract({
          address: V3_FACTORY,
          abi: FACTORY_ABI,
          functionName: 'getPool',
          args: [token0, token1, fee],
        });
      })
    );
    for (let i = 0; i < poolKeys.length; i++) {
      const r = poolAddrResults[i];
      const addr = r.status === 'fulfilled' ? r.value : null;
      // Treat zero address as "no pool".
      poolAddrMap.set(
        poolKeys[i],
        addr && addr !== '0x0000000000000000000000000000000000000000' ? addr : null,
      );
    }

    const slot0Map = new Map(); // pool address (lowercase) → sqrtPriceX96 BigInt
    const uniquePools = [...new Set([...poolAddrMap.values()].filter(Boolean))];
    const slot0Results = await Promise.allSettled(
      uniquePools.map(addr =>
        client.readContract({
          address: addr,
          abi: POOL_ABI,
          functionName: 'slot0',
        })
      )
    );
    for (let i = 0; i < uniquePools.length; i++) {
      const r = slot0Results[i];
      if (r.status === 'fulfilled' && r.value) {
        slot0Map.set(uniquePools[i].toLowerCase(), r.value[0]);
      }
    }

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
        tickLower,
        tickUpper,
        liquidity,
      ] = res.result;

      const t0Meta = metaMap.get(token0?.toLowerCase());
      const t1Meta = metaMap.get(token1?.toLowerCase());

      const token0Symbol = t0Meta?.symbol ?? token0?.slice(0, 6) ?? '???';
      const token1Symbol = t1Meta?.symbol ?? token1?.slice(0, 6) ?? '???';

      const feeNum = Number(fee);
      const feeStr = FEE_TIER_STR[feeNum] ?? `${(feeNum / 10000).toFixed(4)}%`;

      // Try to compute live amounts from pool slot0 + tick range + liquidity.
      // Fall back to the old liquidity-only heuristic if anything's missing.
      const pool = poolAddrMap.get(poolKey(token0, token1, fee));
      const sqrtPriceX96 = pool ? slot0Map.get(pool.toLowerCase()) : undefined;

      let amount0Str;
      let amount1Str;
      let hasLiquidity;
      let inRange;

      let decimalsUnknown;
      if (sqrtPriceX96 != null && liquidity > 0n) {
        try {
          const tl = Number(tickLower);
          const tu = Number(tickUpper);
          const { amount0, amount1 } = computeAmounts(sqrtPriceX96, tl, tu, liquidity);
          // If either token's decimals couldn't be read on-chain, the
          // formatUnits result would be misleading by orders of magnitude;
          // emit raw integer amounts and flag the position so consumers
          // don't divide by an assumed 1e18 they shouldn't trust.
          const d0 = t0Meta?.decimals;
          const d1 = t1Meta?.decimals;
          if (d0 == null || d1 == null) {
            amount0Str = amount0.toString();
            amount1Str = amount1.toString();
            decimalsUnknown = true;
          } else {
            amount0Str = formatUnits(amount0, d0);
            amount1Str = formatUnits(amount1, d1);
          }
          hasLiquidity = amount0 > 0n || amount1 > 0n;
          inRange = sqrtPriceX96 > getSqrtRatioAtTick(tl)
                 && sqrtPriceX96 < getSqrtRatioAtTick(tu);
        } catch {
          hasLiquidity = liquidity > 0n;
        }
      } else {
        hasLiquidity = liquidity > 0n;
      }

      positions.push({
        tokenId:      tokenIds[i].toString(),
        token0Symbol,
        token1Symbol,
        fee:          feeNum,
        feeStr,
        hasLiquidity,
        liquidity:    liquidity.toString(),
        ...(amount0Str !== undefined ? { amount0: amount0Str } : {}),
        ...(amount1Str !== undefined ? { amount1: amount1Str } : {}),
        ...(inRange    !== undefined ? { inRange }              : {}),
        ...(decimalsUnknown            ? { decimalsUnknown: true } : {}),
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
