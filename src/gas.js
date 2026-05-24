/**
 * src/gas.js
 *
 * Multi-chain gas data fetcher (EVM + Bitcoin + Solana).
 *
 * EVM chains: single eth_feeHistory call per chain → base fee, priority tiers
 * (p10/50/90 reward percentiles), block estimates, sparkline. Falls back to
 * eth_getBlockByNumber + eth_maxPriorityFeePerGas if feeHistory unavailable.
 *
 * Bitcoin: mempool.space recommended fees + mempool stats (no key needed).
 * Falls back to blockstream.info estimates.
 *
 * Solana: getRecentPrioritizationFees + getRecentPerformanceSamples for
 * priority tiers and congestion signal.
 *
 * Exports:
 *   getGas(chainName)              => Promise<GasResult>
 *   getAllGas(chains?, opts?)      => Promise<GasResult[]>
 *   GAS_CHAINS                     — string[] of supported chain names
 *   EVM_GAS_CHAINS                 — EVM-only subset
 *   sparklineFromHistory(history)  — derive 12-point sparkline data
 */

import { formatUnits } from 'viem';

import * as ethereum from './chains/ethereum.js';
import * as polygon  from './chains/polygon.js';
import * as arbitrum from './chains/arbitrum.js';
import * as base     from './chains/base.js';
import * as optimism from './chains/optimism.js';
import * as zksync   from './chains/zksync.js';
import * as linea    from './chains/linea.js';
import { makeClient } from './chains/_evm.js';

// ─── Chain registries ────────────────────────────────────────────────────────

const EVM_ADAPTERS = {
  ethereum,
  polygon,
  arbitrum,
  base,
  optimism,
  zksync,
  linea,
};

export const EVM_GAS_CHAINS = Object.keys(EVM_ADAPTERS);
export const GAS_CHAINS = [...EVM_GAS_CHAINS, 'bitcoin', 'solana'];

const L2_CHAINS = new Set(['arbitrum', 'base', 'optimism', 'zksync', 'linea']);

// ─── EVM constants ───────────────────────────────────────────────────────────

const FEE_HISTORY_BLOCKS    = 64;
const REWARD_PERCENTILES    = [10, 50, 90];
const SPARKLINE_POINTS      = 12;
// EIP-1559 upper bound: base fee can rise at most 12.5% per block (when the
// previous block was 100% full). This is a ceiling, NOT a forecast.
const MAX_INCREASE_PER_BLOCK = 1.125;

// OP Stack L1 gas-price oracle predeploy (Optimism, Base). Exposes
// getL1Fee(bytes) returning the L1 data-posting fee in wei for given calldata.
const OP_STACK_L1_GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const OP_STACK_GAS_ORACLE_ABI = [{
  name: 'getL1Fee',
  type: 'function',
  stateMutability: 'view',
  inputs:  [{ name: '_data', type: 'bytes' }],
  outputs: [{ name: '',      type: 'uint256' }],
}];
// Canonical sample calldata: a typical ERC-20 `transfer(address,uint256)` —
// 68 bytes — a representative payload for an L2 user transaction.
const SAMPLE_ERC20_TRANSFER_CALLDATA =
  '0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead' +
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
const OP_STACK_L1_FEE_CHAINS = new Set(['optimism', 'base']);

// ─── Bitcoin constants ───────────────────────────────────────────────────────

const MEMPOOL_FEES_URL    = 'https://mempool.space/api/v1/fees/recommended';
const MEMPOOL_STATS_URL   = 'https://mempool.space/api/mempool';
const BLOCKSTREAM_FEES_URL = 'https://blockstream.info/api/fee-estimates';

// Standard tx sizes in vB (used for USD cost estimation)
export const BTC_TX_SIZES = {
  p2wpkh: 141, // standard native segwit transfer
  p2sh:   250, // typical multi-input nested-segwit
};

// ─── Solana constants ────────────────────────────────────────────────────────

// Free public Solana RPCs tried in order — same curated list as
// src/chains/solana.js (re-verified 2026-05; no API key required).
const SOLANA_RPC_URLS = [
  'https://solana.lava.build',
  'https://api.mainnet-beta.solana.com',
];
const SOLANA_BASE_LAMPORTS_PER_SIG = 5_000;

// Compute units for typical transaction types
export const SOL_TX_CU = {
  transfer:    200,
  splTransfer: 5_000,
  swap:        150_000,
};

// ─── Generic helpers ─────────────────────────────────────────────────────────

/** Wei → gwei (number). */
function weiHexToGwei(hex) {
  if (hex == null) return 0;
  const wei = typeof hex === 'bigint' ? hex : BigInt(hex);
  return parseFloat(formatUnits(wei, 9));
}

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** percentile of a sorted-ascending array (1-based ceil index). */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

/**
 * Subsample an array down to `target` evenly-spaced points.
 *
 * @param {number[]} arr
 * @param {number} target
 * @returns {number[]}
 */
export function sparklineFromHistory(arr, target = SPARKLINE_POINTS) {
  if (!arr || arr.length === 0) return [];
  if (arr.length <= target) return [...arr];
  const out = new Array(target);
  const step = (arr.length - 1) / (target - 1);
  for (let i = 0; i < target; i++) {
    out[i] = arr[Math.round(i * step)];
  }
  return out;
}

function projectBaseFee(baseGwei, blocks) {
  return baseGwei * Math.pow(MAX_INCREASE_PER_BLOCK, blocks);
}

function derivePriorityTiers(reward) {
  if (!Array.isArray(reward) || reward.length === 0) {
    return { low: 0, med: 0, high: 0 };
  }
  const lows  = reward.map(r => weiHexToGwei(r?.[0]));
  const meds  = reward.map(r => weiHexToGwei(r?.[1]));
  const highs = reward.map(r => weiHexToGwei(r?.[2]));
  return {
    low:  median(lows),
    med:  median(meds),
    high: median(highs),
  };
}

// ─── EVM fetcher ─────────────────────────────────────────────────────────────

async function getEvmGas(chainName) {
  const adapter = EVM_ADAPTERS[chainName];
  const client  = makeClient(adapter.RPC_URLS[0], adapter.viemChain);
  const isL2    = L2_CHAINS.has(chainName);

  // Primary path: eth_feeHistory.
  try {
    const fh = await client.request({
      method: 'eth_feeHistory',
      params: [
        '0x' + FEE_HISTORY_BLOCKS.toString(16),
        'latest',
        REWARD_PERCENTILES,
      ],
    });

    const baseFees = (fh.baseFeePerGas ?? []).map(weiHexToGwei);
    if (baseFees.length === 0) throw new Error('empty baseFeePerGas');

    const nextBlockBase = baseFees[baseFees.length - 1];
    const currentBase   = baseFees[baseFees.length - 2] ?? nextBlockBase;
    const history       = baseFees.slice(0, -1);
    const sparkline     = sparklineFromHistory(history);
    const priority      = derivePriorityTiers(fh.reward ?? []);

    // Skip multi-block worst-case ceilings for chains that don't follow vanilla
    // EIP-1559 update mechanics (Arbitrum, zkSync).
    const skipWorstCase  = chainName === 'arbitrum' || chainName === 'zksync';
    const nextBlockTotal = nextBlockBase + priority.med;
    // 1.125^n upper bound — the maximum the base fee can reach after n blocks
    // under EIP-1559 (every block 100% full). Not a forecast.
    const worstCase5Blocks  = skipWorstCase ? null : projectBaseFee(currentBase, 5)  + priority.med;
    const worstCase20Blocks = skipWorstCase ? null : projectBaseFee(currentBase, 20) + priority.med;

    // L1 data fee for OP Stack L2s (Optimism, Base). Best-effort: an RPC
    // failure leaves l1FeeWei = null and the L2 portion still renders.
    // For non-OP-Stack L2s (Linea, zkSync) the L1/pubdata component is NOT
    // modeled — emit the 'unsupported' sentinel so the renderer can
    // distinguish intentional omission from an RPC failure.
    let l1FeeWei;
    if (OP_STACK_L1_FEE_CHAINS.has(chainName)) {
      l1FeeWei = await fetchOpStackL1Fee(client);
    } else if (isL2) {
      l1FeeWei = 'unsupported';
    } else {
      l1FeeWei = null;
    }

    return baseEvmResult(chainName, adapter.nativeSymbol, isL2, {
      baseFeeGwei:  currentBase,
      priorityGwei: priority,
      nextBlock:    { totalGwei: nextBlockTotal },
      worstCase5:   worstCase5Blocks  != null ? { totalGwei: worstCase5Blocks }  : null,
      worstCase20:  worstCase20Blocks != null ? { totalGwei: worstCase20Blocks } : null,
      l1FeeWei,
      history,
      sparkline,
      degraded: false,
    });
  } catch (primaryErr) {
    // Fallback: latest block + maxPriorityFeePerGas.
    try {
      const block = await client.getBlock({ blockTag: 'latest' });
      const baseGwei = block.baseFeePerGas != null
        ? weiHexToGwei(block.baseFeePerGas)
        : 0;

      let priorityGwei = 0;
      try {
        const tip = await client.request({ method: 'eth_maxPriorityFeePerGas' });
        priorityGwei = weiHexToGwei(tip);
      } catch { /* zero on chains that don't implement it */ }

      return baseEvmResult(chainName, adapter.nativeSymbol, isL2, {
        baseFeeGwei:  baseGwei,
        priorityGwei: { low: priorityGwei, med: priorityGwei, high: priorityGwei },
        nextBlock:    { totalGwei: baseGwei + priorityGwei },
        worstCase5:   null,
        worstCase20:  null,
        l1FeeWei:     isL2 && !OP_STACK_L1_FEE_CHAINS.has(chainName) ? 'unsupported' : null,
        history:      [],
        sparkline:    [],
        degraded:     true,
      });
    } catch (fallbackErr) {
      return errorResult(chainName, primaryErr?.shortMessage ?? primaryErr?.message ?? String(primaryErr));
    }
  }
}

function baseEvmResult(chain, nativeSymbol, isL2, fields) {
  return {
    chain,
    family:       'evm',
    nativeSymbol,
    isL2,
    bitcoin:      null,
    solana:       null,
    error:        null,
    ...fields,
  };
}

/**
 * Best-effort OP Stack L1 data-fee fetch. Returns the L1 fee in wei for a
 * sample ERC-20 transfer, or null on any failure (the L2 portion still
 * renders so gas reporting degrades gracefully on RPC issues).
 *
 * @param {ReturnType<typeof makeClient>} client
 * @returns {Promise<bigint | null>}
 */
async function fetchOpStackL1Fee(client) {
  try {
    const fee = await client.readContract({
      address:      OP_STACK_L1_GAS_ORACLE,
      abi:          OP_STACK_GAS_ORACLE_ABI,
      functionName: 'getL1Fee',
      args:         [SAMPLE_ERC20_TRANSFER_CALLDATA],
    });
    return typeof fee === 'bigint' ? fee : BigInt(fee);
  } catch {
    return null;
  }
}

// ─── Bitcoin fetcher ─────────────────────────────────────────────────────────

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal:  AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getBitcoinGas() {
  // Primary: mempool.space recommended fees + mempool stats (parallel).
  try {
    const [fees, stats] = await Promise.all([
      fetchJson(MEMPOOL_FEES_URL),
      fetchJson(MEMPOOL_STATS_URL).catch(() => null),
    ]);

    const mempool = stats
      ? {
          count:    Number(stats.count) || 0,
          vsizeMB:  (Number(stats.vsize) || 0) / 1_000_000,
        }
      : null;

    return {
      chain:        'bitcoin',
      family:       'bitcoin',
      nativeSymbol: 'BTC',
      isL2:         false,
      bitcoin: {
        fees: {
          fastest:  Number(fees.fastestFee)  || 0,
          halfHour: Number(fees.halfHourFee) || 0,
          hour:     Number(fees.hourFee)     || 0,
          economy:  Number(fees.economyFee)  || 0,
          minimum:  Number(fees.minimumFee)  || 0,
        },
        mempool,
      },
      solana:   null,
      degraded: false,
      error:    null,
    };
  } catch (primaryErr) {
    // Fallback: blockstream.info (no economy/minimum tier).
    try {
      const data = await fetchJson(BLOCKSTREAM_FEES_URL);
      return {
        chain:        'bitcoin',
        family:       'bitcoin',
        nativeSymbol: 'BTC',
        isL2:         false,
        bitcoin: {
          fees: {
            fastest:  Math.round(Number(data['1']) || 0),
            halfHour: Math.round(Number(data['3']) || 0),
            hour:     Math.round(Number(data['6']) || 0),
            economy:  null,
            minimum:  null,
          },
          mempool: null,
        },
        solana:   null,
        degraded: true,
        error:    null,
      };
    } catch (fallbackErr) {
      return errorResult('bitcoin', primaryErr?.message ?? String(primaryErr));
    }
  }
}

// ─── Solana fetcher ──────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ result: any, source: string }>} — `source` is the URL
 *   that successfully answered (for provenance / attribution).
 */
async function solanaRpc(method, params, timeoutMs = 8000) {
  let lastErr;
  for (const url of SOLANA_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal:  AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      if (json.error) {
        lastErr = new Error(json.error.message ?? 'rpc error');
        continue;
      }
      return { result: json.result, source: url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('all Solana RPCs failed');
}

/**
 * Classify Solana network state from p50 priority + TPS.
 *
 * @param {number} p50
 * @param {number|null} tps
 * @returns {'low'|'normal'|'congested'}
 */
function classifySolanaCongestion(p50, tps) {
  if (p50 > 50_000 || (tps != null && tps > 4000)) return 'congested';
  if (p50 < 1_000  && (tps == null || tps < 3000)) return 'low';
  return 'normal';
}

async function getSolanaGas() {
  try {
    const [feesCall, perfCall] = await Promise.all([
      solanaRpc('getRecentPrioritizationFees', [[]]),
      solanaRpc('getRecentPerformanceSamples', [4]).catch(() => null),
    ]);

    const feesRes = feesCall.result;
    const perfRes = perfCall?.result ?? null;

    const fees = (feesRes ?? [])
      .map(e => Number(e?.prioritizationFee))
      .filter(f => f > 0)
      .sort((a, b) => a - b);

    const priority = {
      low:  percentile(fees, 25),
      med:  percentile(fees, 50),
      high: percentile(fees, 75),
    };

    const sample = perfRes?.[0] ?? null;
    const tps = sample
      ? Math.round(Number(sample.numTransactions) / Number(sample.samplePeriodSecs))
      : null;

    const congestion = classifySolanaCongestion(priority.med, tps);

    return {
      chain:        'solana',
      family:       'solana',
      nativeSymbol: 'SOL',
      isL2:         false,
      bitcoin:      null,
      solana: {
        baseLamports: SOLANA_BASE_LAMPORTS_PER_SIG,
        priorityMicroLamports: priority,
        tps,
        congestion,
        sampleCount: fees.length,
      },
      degraded: false,
      error:    null,
    };
  } catch (err) {
    return errorResult('solana', err?.message ?? String(err));
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch gas data for a single chain.
 * Never throws — returns { error } on failure.
 *
 * @param {string} chainName
 * @returns {Promise<GasResult>}
 */
export async function getGas(chainName) {
  if (chainName === 'bitcoin') return getBitcoinGas();
  if (chainName === 'solana')  return getSolanaGas();
  if (EVM_ADAPTERS[chainName]) return getEvmGas(chainName);
  return errorResult(chainName, `Unknown chain: ${chainName}`);
}

/**
 * Fetch gas data for many chains in parallel. Failures isolated.
 *
 * @param {string[]} [chains]
 * @param {{ onProgress?: (chain: string, status: 'ok'|'fail', ms: number) => void }} [opts]
 * @returns {Promise<GasResult[]>}
 */
export async function getAllGas(chains = GAS_CHAINS, opts = {}) {
  const { onProgress } = opts;
  return Promise.all(
    chains.map(async (chain) => {
      const t0 = Date.now();
      const res = await getGas(chain);
      const ms = Date.now() - t0;
      if (onProgress) onProgress(chain, res.error ? 'fail' : 'ok', ms);
      return res;
    }),
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function errorResult(chainName, message) {
  const family =
    chainName === 'bitcoin' ? 'bitcoin' :
    chainName === 'solana'  ? 'solana'  :
    'evm';
  const adapter = EVM_ADAPTERS[chainName];
  const nativeSymbol =
    family === 'bitcoin' ? 'BTC' :
    family === 'solana'  ? 'SOL' :
    adapter?.nativeSymbol ?? 'ETH';

  return {
    chain:        chainName,
    family,
    nativeSymbol,
    isL2:         L2_CHAINS.has(chainName),
    baseFeeGwei:  null,
    priorityGwei: null,
    nextBlock:    null,
    worstCase5:   null,
    worstCase20:  null,
    l1FeeWei:     null,
    history:      [],
    sparkline:    [],
    bitcoin:      null,
    solana:       null,
    degraded:     false,
    error:        message,
  };
}

/**
 * @typedef {{
 *   chain: string,
 *   family: 'evm' | 'bitcoin' | 'solana',
 *   nativeSymbol: 'ETH' | 'POL' | 'BTC' | 'SOL',
 *   isL2: boolean,
 *   baseFeeGwei?: number | null,
 *   priorityGwei?: { low: number, med: number, high: number } | null,
 *   nextBlock?: { totalGwei: number } | null,
 *   worstCase5?:  { totalGwei: number } | null,
 *   worstCase20?: { totalGwei: number } | null,
 *   l1FeeWei?: bigint | null | 'unsupported',
 *   history?: number[],
 *   sparkline?: number[],
 *   bitcoin?: {
 *     fees: { fastest: number, halfHour: number, hour: number, economy: number|null, minimum: number|null },
 *     mempool: { count: number, vsizeMB: number } | null,
 *   } | null,
 *   solana?: {
 *     baseLamports: number,
 *     priorityMicroLamports: { low: number, med: number, high: number },
 *     tps: number | null,
 *     congestion: 'low' | 'normal' | 'congested',
 *     sampleCount: number,
 *   } | null,
 *   degraded: boolean,
 *   error: string | null,
 * }} GasResult
 */
