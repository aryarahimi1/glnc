/**
 * src/positions/aave.js
 *
 * Fetch Aave V3 lending positions for an address on any supported EVM chain.
 * Uses getUserAccountData from the Aave V3 Pool contract.
 *
 * Exports:
 *   getAavePositions(address, chain) → Promise<AaveResult>
 */

import { createPublicClient, http, formatUnits } from 'viem';

// MaxUint256 — 2^256 - 1 (what Aave returns for healthFactor when debt === 0)
const MaxUint256 = 2n ** 256n - 1n;
import { mainnet } from 'viem/chains';
import { polygon } from 'viem/chains';
import { arbitrum } from 'viem/chains';
import { base } from 'viem/chains';

// ─── Aave V3 Pool contract addresses per chain ────────────────────────────────

const AAVE_V3_POOL = {
  ethereum: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  polygon:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  base:     '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
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

// ─── Minimal ABI for getUserAccountData ──────────────────────────────────────

const POOL_ABI = [
  {
    name: 'getUserAccountData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase',        type: 'uint256' },
      { name: 'totalDebtBase',              type: 'uint256' },
      { name: 'availableBorrowsBase',       type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv',                        type: 'uint256' },
      { name: 'healthFactor',               type: 'uint256' },
    ],
  },
];

// ─── Client cache (one per chain per process) ─────────────────────────────────

const _clients = new Map();

/**
 * Return a viem PublicClient for the given chain, creating it once.
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
 *   hasPosition: boolean,
 *   collateralUsd?: string,
 *   debtUsd?: string,
 *   netUsd?: string,
 *   healthFactor?: string,
 *   error?: string,
 * }} AaveResult
 */

/**
 * Fetch the Aave V3 account data for an address on a specific chain.
 *
 * totalCollateralBase and totalDebtBase are denominated in USD with 8 decimal
 * places (i.e. formatUnits(x, 8) gives the USD value).
 * healthFactor uses 18 decimal places.  When there is no debt the protocol
 * returns MaxUint256 — displayed as '∞'.
 *
 * Returns { hasPosition: false } when totalCollateralBase is zero (no position).
 * Never throws.
 *
 * @param {string} address  — checksummed EVM address
 * @param {string} chain    — 'ethereum' | 'polygon' | 'arbitrum' | 'base'
 * @returns {Promise<AaveResult>}
 */
export async function getAavePositions(address, chain) {
  const poolAddress = AAVE_V3_POOL[chain];
  if (!poolAddress) {
    return { hasPosition: false, error: `Aave V3 not configured for chain: ${chain}` };
  }

  try {
    const client = getClient(chain);

    const [
      totalCollateralBase,
      totalDebtBase,
      _availableBorrows,
      _liquidationThreshold,
      _ltv,
      healthFactor,
    ] = await client.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: 'getUserAccountData',
      args: [address],
    });

    // No collateral → no active position
    if (totalCollateralBase === 0n) {
      return { hasPosition: false };
    }

    // USD values: 8 decimal places
    const collateralUsd = formatUnits(totalCollateralBase, 8);
    const debtUsd       = formatUnits(totalDebtBase, 8);

    const collateralNum = parseFloat(collateralUsd);
    const debtNum       = parseFloat(debtUsd);
    const netUsd        = (collateralNum - debtNum).toFixed(2);

    // Health factor: 18 decimals; MaxUint256 means no debt → display as '∞'
    let healthFactorStr;
    if (healthFactor === MaxUint256 || totalDebtBase === 0n) {
      healthFactorStr = '∞';
    } else {
      const hfNum = parseFloat(formatUnits(healthFactor, 18));
      healthFactorStr = hfNum.toFixed(2);
    }

    return {
      hasPosition:   true,
      collateralUsd: parseFloat(collateralUsd).toFixed(2),
      debtUsd:       parseFloat(debtUsd).toFixed(2),
      netUsd,
      healthFactor:  healthFactorStr,
    };
  } catch (err) {
    return {
      hasPosition: false,
      error: err?.message ?? String(err),
    };
  }
}
