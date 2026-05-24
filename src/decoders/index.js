/**
 * src/decoders/index.js
 *
 * Transaction decoder.
 *
 * Exports:
 *   decodeTransaction(chain, txHash) => Promise<DecodedTransaction>
 *
 * DecodedTransaction shape:
 * {
 *   hash:         string,
 *   chain:        string,
 *   from:         string | null,
 *   to:           string | null,
 *   value:        string,          // native token amount (e.g. '0.05 ETH')
 *   gasUsed:      string,
 *   gasPriceGwei: string,
 *   gasCostUsd:   string,          // e.g. '$2.34' or 'N/A'
 *   status:       'success' | 'failed' | 'pending' | 'unknown',
 *   summary:      string,          // plain-English description
 *   raw:          object,          // raw tx + receipt from the adapter
 * }
 */

import { decodeAbiParameters, formatUnits, parseAbiParameters } from 'viem';
import { lookupSelector } from './registry.js';
import { decodeMultiSend } from './multisend.js';
import { getChainAdapter } from '../chains/index.js';
import { fetchTokenMeta } from '../chains/_evm.js';
import { getPrice } from '../prices.js';
import { decodeReceiptLogs } from './events.js';
import { formatBtc } from '../chains/bitcoin.js';
import { jsonSafeQuorum } from '../output/serialize.js';

// Re-use a single viem client per chain for token symbol lookups
import { makeClient } from '../chains/_evm.js';
import { mainnet }   from 'viem/chains';
import { polygon }   from 'viem/chains';
import { arbitrum }  from 'viem/chains';
import { base }      from 'viem/chains';
import { optimism } from 'viem/chains';
import { linea }    from 'viem/chains';
import { zksync }   from 'viem/chains';

const CHAIN_CLIENT_CONFIG = {
  ethereum: { rpc: 'https://ethereum-rpc.publicnode.com',    viemChain: mainnet  },
  polygon:  { rpc: 'https://polygon-bor-rpc.publicnode.com',  viemChain: polygon  },
  arbitrum: { rpc: 'https://arb1.arbitrum.io/rpc',      viemChain: arbitrum },
  base:     { rpc: 'https://mainnet.base.org',          viemChain: base     },
  optimism: { rpc: 'https://optimism-rpc.publicnode.com', viemChain: optimism },
  linea:    { rpc: 'https://linea-rpc.publicnode.com',    viemChain: linea    },
  zksync:   { rpc: 'https://mainnet.era.zksync.io',       viemChain: zksync   },
};

const clientCache = new Map();

const MAX_NESTED_DEPTH  = 3;
const MAX_NESTED_BYTES  = 65_536;
const MULTISEND_SELECTOR = '0x8d80ff0a';

function getClient(chainName) {
  if (clientCache.has(chainName)) return clientCache.get(chainName);
  const cfg = CHAIN_CLIENT_CONFIG[chainName];
  if (!cfg) return null;
  const c = makeClient(cfg.rpc, cfg.viemChain);
  clientCache.set(chainName, c);
  return c;
}

// ─── In-memory token metadata cache (shared with _evm helpers) ───────────────
// key: `${chain}:${contractAddress_lowercase}` → { symbol, decimals }
const tokenMetaMemory = new Map();

async function getTokenMeta(chain, contractAddress) {
  const key = `${chain}:${contractAddress.toLowerCase()}`;
  if (tokenMetaMemory.has(key)) return tokenMetaMemory.get(key);

  const client = getClient(chain);
  if (!client) return null;

  const meta = await fetchTokenMeta(client, contractAddress, chain);
  if (meta) tokenMetaMemory.set(key, meta);
  return meta;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Decode the calldata of a tx using the registry entry.
 * Returns decoded parameters as a plain object.
 */
function decodeCalldata(registryEntry, calldata) {
  if (!calldata || calldata === '0x' || registryEntry.inputs.length === 0) {
    return {};
  }
  try {
    // Strip the 4-byte selector, then decode the rest
    const encoded = `0x${calldata.slice(10)}`;
    const decoded = decodeAbiParameters(registryEntry.inputs, encoded);
    const result = {};
    for (let i = 0; i < registryEntry.inputs.length; i++) {
      result[registryEntry.inputs[i].name] = decoded[i];
    }
    return result;
  } catch {
    return {};
  }
}

function normalizeBytesToHex(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (!value || value === '0x') return null;
    return value.startsWith('0x') ? value : `0x${value}`;
  }
  if (value instanceof Uint8Array) {
    if (value.length === 0) return null;
    let hex = '0x';
    for (const b of value) hex += b.toString(16).padStart(2, '0');
    return hex;
  }
  return null;
}

function hexPayloadByteLength(hex) {
  if (!hex || typeof hex !== 'string') return 0;
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Math.floor(body.length / 2);
}

function shouldRecurseBytesField(registryEntry, fieldName) {
  if (registryEntry.protocol === 'Safe' && registryEntry.name === 'execTransaction') {
    return fieldName === 'data';
  }
  return true;
}

function attachNestedChild(children, child) {
  children.push(child);
}

function decodeNested(calldata, depth, byteBudget) {
  const normalized = calldata?.startsWith('0x') ? calldata : `0x${calldata ?? ''}`;
  const payloadBytes = hexPayloadByteLength(normalized);
  if (byteBudget + payloadBytes > MAX_NESTED_BYTES) {
    return { registryEntry: null, params: { children: [{ dropped: true }] } };
  }
  const nextBudget = byteBudget + payloadBytes;

  const registryEntry = lookupSelector(normalized);
  if (!registryEntry) {
    return {
      registryEntry: null,
      params: {
        children: [{ selector: normalized.slice(0, 10), dropped: false }],
      },
    };
  }

  let params;
  try {
    params = decodeCalldata(registryEntry, normalized);
  } catch {
    params = {};
  }
  const children = [];

  if (depth < MAX_NESTED_DEPTH) {
    try {
      if (registryEntry.selector.toLowerCase() === MULTISEND_SELECTOR) {
        const packed = normalizeBytesToHex(params.transactions);
        const ops = packed ? decodeMultiSend(packed) : [];
        for (const op of ops) {
          const innerHex = normalizeBytesToHex(op.data);
          if (!innerHex || innerHex.length < 10) continue;
          const innerBytes = hexPayloadByteLength(innerHex);
          if (nextBudget + innerBytes > MAX_NESTED_BYTES) {
            attachNestedChild(children, { dropped: true });
            continue;
          }
          attachNestedChild(
            children,
            decodeNested(innerHex, depth + 1, nextBudget),
          );
        }
      } else {
        for (const input of registryEntry.inputs) {
          if (input.type === 'bytes[]') {
            const arr = params[input.name] ?? [];
            for (const item of arr) {
              const childHex = normalizeBytesToHex(item);
              if (!childHex || childHex.length < 10) continue;
              const childBytes = hexPayloadByteLength(childHex);
              if (nextBudget + childBytes > MAX_NESTED_BYTES) {
                attachNestedChild(children, { dropped: true });
                continue;
              }
              attachNestedChild(
                children,
                decodeNested(childHex, depth + 1, nextBudget),
              );
            }
          } else if (input.type === 'bytes' && shouldRecurseBytesField(registryEntry, input.name)) {
            const childHex = normalizeBytesToHex(params[input.name]);
            if (!childHex || childHex.length < 10) continue;
            const childBytes = hexPayloadByteLength(childHex);
            if (nextBudget + childBytes > MAX_NESTED_BYTES) {
              attachNestedChild(children, { dropped: true });
              continue;
            }
            attachNestedChild(
              children,
              decodeNested(childHex, depth + 1, nextBudget),
            );
          }
        }
      }
    } catch {
      // Malformed nested payload — leave children empty
    }
  } else if (registryEntry.selector.toLowerCase() === MULTISEND_SELECTOR) {
    const packed = normalizeBytesToHex(params.transactions);
    const ops = packed ? decodeMultiSend(packed) : [];
    for (const op of ops) {
      const innerHex = normalizeBytesToHex(op.data);
      if (innerHex && innerHex.length >= 10) {
        attachNestedChild(children, { dropped: true });
      }
    }
  } else {
    // At max depth: flag nested calldata that was not expanded
    for (const input of registryEntry.inputs) {
      const hasNested =
        input.type === 'bytes[]'
          ? (params[input.name] ?? []).some(v => normalizeBytesToHex(v)?.length >= 10)
          : input.type === 'bytes' && shouldRecurseBytesField(registryEntry, input.name)
            ? (normalizeBytesToHex(params[input.name])?.length ?? 0) >= 10
            : false;
      if (hasNested) {
        attachNestedChild(children, { dropped: true });
        break;
      }
    }
  }

  params.children = children;
  return { registryEntry, params };
}

async function summarizeChildren(chain, children, tx) {
  const parts = [];
  for (const child of children ?? []) {
    if (child.dropped) {
      parts.push('+1 deeper call not expanded');
      continue;
    }
    if (child.registryEntry) {
      parts.push(await buildSummary(chain, child.registryEntry, child.params, tx));
    } else if (child.selector) {
      parts.push(`unknown selector ${child.selector}`);
    }
  }
  return parts;
}

/**
 * Format a bigint token amount with on-chain decimals.
 */
function fmt(amount, decimals) {
  return formatUnits(amount, decimals);
}

/**
 * Build a human-readable summary for a decoded call.
 * Falls back to a generic summary when params are unavailable.
 */
async function buildSummary(chain, registryEntry, params, tx) {
  const fn       = registryEntry.name;
  const protocol = registryEntry.protocol;

  try {
    // ── ERC20 transfer ────────────────────────────────────────────────────────
    if (fn === 'transfer' && protocol === 'ERC20') {
      const toAddr = tx?.to;
      const meta   = toAddr ? await getTokenMeta(chain, toAddr) : null;
      const sym    = meta?.symbol ?? 'tokens';
      const dec    = meta?.decimals ?? 18;
      const amt    = fmt(params.amount ?? 0n, dec);
      return `Transferred ${amt} ${sym} to ${params.recipient}`;
    }

    // ── ERC20 approve ─────────────────────────────────────────────────────────
    if (fn === 'approve' && protocol === 'ERC20') {
      const toAddr = tx?.to;
      const meta   = toAddr ? await getTokenMeta(chain, toAddr) : null;
      const sym    = meta?.symbol ?? 'tokens';
      const dec    = meta?.decimals ?? 18;
      const amt    = params.amount === BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
        ? 'unlimited'
        : fmt(params.amount ?? 0n, dec);
      return `Approved ${amt} ${sym} to ${params.spender}`;
    }

    // ── ERC20 transferFrom ────────────────────────────────────────────────────
    if (fn === 'transferFrom' && protocol === 'ERC20') {
      const toAddr = tx?.to;
      const meta   = toAddr ? await getTokenMeta(chain, toAddr) : null;
      const sym    = meta?.symbol ?? 'tokens';
      const dec    = meta?.decimals ?? 18;
      const amt    = fmt(params.amount ?? 0n, dec);
      return `Transferred ${amt} ${sym} from ${params.sender} to ${params.recipient}`;
    }

    // ── WETH deposit ──────────────────────────────────────────────────────────
    if (fn === 'deposit' && protocol === 'WETH') {
      const ethAmt = fmt(tx?.value ?? 0n, 18);
      return `Wrapped ${ethAmt} ETH into WETH`;
    }

    // ── WETH withdraw ─────────────────────────────────────────────────────────
    if (fn === 'withdraw' && protocol === 'WETH') {
      const wethAmt = fmt(params.wad ?? 0n, 18);
      return `Unwrapped ${wethAmt} WETH into ETH`;
    }

    // ── Uniswap V2: swapExactTokensForTokens ─────────────────────────────────
    if (fn === 'swapExactTokensForTokens' && protocol === 'Uniswap V2') {
      const path = params.path ?? [];
      const [inMeta, outMeta] = await Promise.all([
        path[0] ? getTokenMeta(chain, path[0]) : null,
        path[path.length - 1] ? getTokenMeta(chain, path[path.length - 1]) : null,
      ]);
      const inSym  = inMeta?.symbol  ?? 'tokens';
      const outSym = outMeta?.symbol ?? 'tokens';
      const inAmt  = fmt(params.amountIn ?? 0n, inMeta?.decimals ?? 18);
      return `Swapped ${inAmt} ${inSym} for ${outSym} via Uniswap V2`;
    }

    // ── Uniswap V2: swapExactETHForTokens ────────────────────────────────────
    if (fn === 'swapExactETHForTokens' && protocol === 'Uniswap V2') {
      const path   = params.path ?? [];
      const outMeta = path[path.length - 1] ? await getTokenMeta(chain, path[path.length - 1]) : null;
      const outSym  = outMeta?.symbol ?? 'tokens';
      const ethAmt  = fmt(tx?.value ?? 0n, 18);
      return `Swapped ${ethAmt} ETH for ${outSym} via Uniswap V2`;
    }

    // ── Uniswap V2: swapExactTokensForETH ────────────────────────────────────
    if (fn === 'swapExactTokensForETH' && protocol === 'Uniswap V2') {
      const path = params.path ?? [];
      const inMeta = path[0] ? await getTokenMeta(chain, path[0]) : null;
      const inSym  = inMeta?.symbol ?? 'tokens';
      const inAmt  = fmt(params.amountIn ?? 0n, inMeta?.decimals ?? 18);
      return `Swapped ${inAmt} ${inSym} for ETH via Uniswap V2`;
    }

    // ── Uniswap V2: swapTokensForExactTokens / swapTokensForExactETH ─────────
    if ((fn === 'swapTokensForExactTokens' || fn === 'swapTokensForExactETH') && protocol === 'Uniswap V2') {
      const path = params.path ?? [];
      const [inMeta, outMeta] = await Promise.all([
        path[0] ? getTokenMeta(chain, path[0]) : null,
        path[path.length - 1] ? getTokenMeta(chain, path[path.length - 1]) : null,
      ]);
      const inSym  = inMeta?.symbol  ?? 'tokens';
      const outSym = outMeta?.symbol ?? (fn.endsWith('ETH') ? 'ETH' : 'tokens');
      const outAmt = fmt(params.amountOut ?? 0n, outMeta?.decimals ?? 18);
      return `Swapped ${inSym} for exactly ${outAmt} ${outSym} via Uniswap V2`;
    }

    // ── Uniswap V2: swapETHForExactTokens ────────────────────────────────────
    if (fn === 'swapETHForExactTokens' && protocol === 'Uniswap V2') {
      const path = params.path ?? [];
      const outMeta = path[path.length - 1] ? await getTokenMeta(chain, path[path.length - 1]) : null;
      const outSym  = outMeta?.symbol ?? 'tokens';
      const outAmt  = fmt(params.amountOut ?? 0n, outMeta?.decimals ?? 18);
      return `Swapped ETH for exactly ${outAmt} ${outSym} via Uniswap V2`;
    }

    // ── Uniswap V3: exactInputSingle ─────────────────────────────────────────
    if (fn === 'exactInputSingle' && protocol === 'Uniswap V3') {
      const p = params.params ?? {};
      const [inMeta, outMeta] = await Promise.all([
        p.tokenIn  ? getTokenMeta(chain, p.tokenIn)  : null,
        p.tokenOut ? getTokenMeta(chain, p.tokenOut) : null,
      ]);
      const inSym  = inMeta?.symbol  ?? p.tokenIn?.slice(0, 8)  ?? 'Token';
      const outSym = outMeta?.symbol ?? p.tokenOut?.slice(0, 8) ?? 'Token';
      const inAmt  = fmt(p.amountIn ?? 0n, inMeta?.decimals ?? 18);
      return `Swapped ${inAmt} ${inSym} for ${outSym} via Uniswap V3`;
    }

    // ── Uniswap V3: exactOutputSingle ────────────────────────────────────────
    if (fn === 'exactOutputSingle' && protocol === 'Uniswap V3') {
      const p = params.params ?? {};
      const [inMeta, outMeta] = await Promise.all([
        p.tokenIn  ? getTokenMeta(chain, p.tokenIn)  : null,
        p.tokenOut ? getTokenMeta(chain, p.tokenOut) : null,
      ]);
      const inSym  = inMeta?.symbol  ?? 'Token';
      const outSym = outMeta?.symbol ?? 'Token';
      const outAmt = fmt(p.amountOut ?? 0n, outMeta?.decimals ?? 18);
      return `Swapped ${inSym} for exactly ${outAmt} ${outSym} via Uniswap V3`;
    }

    // ── Uniswap V3: exactInput (multi-hop) ───────────────────────────────────
    if (fn === 'exactInput' && protocol === 'Uniswap V3') {
      const p = params.params ?? {};
      const inAmt = fmt(p.amountIn ?? 0n, 18);
      return `Multi-hop swap of ${inAmt} tokens via Uniswap V3`;
    }

    // ── Uniswap V3: exactOutput (multi-hop) ──────────────────────────────────
    if (fn === 'exactOutput' && protocol === 'Uniswap V3') {
      const p = params.params ?? {};
      const outAmt = fmt(p.amountOut ?? 0n, 18);
      return `Multi-hop swap for exactly ${outAmt} tokens via Uniswap V3`;
    }

    // ── Uniswap Universal Router ──────────────────────────────────────────────
    if (fn === 'execute' && protocol === 'Uniswap Universal Router') {
      return `Multi-command swap via Uniswap Universal Router`;
    }

    // ── Governor propose ──────────────────────────────────────────────────────
    if (fn === 'propose' && (protocol === 'GovernorBravo' || protocol === 'OZ Governor')) {
      const targets = params.targets ?? [];
      const inner   = await summarizeChildren(chain, params.children, tx);
      const n       = targets.length || inner.length;
      const detail  = inner.length ? inner.join('; ') : 'no inner calls expanded';
      return `Proposed governance action with ${n} targets: ${detail}`;
    }

    // ── Governor / Timelock batch ops ─────────────────────────────────────────
    if (
      (fn === 'execute' || fn === 'executeBatch' || fn === 'schedule' || fn === 'scheduleBatch')
      && (protocol === 'GovernorBravo' || protocol === 'OZ Governor' || protocol === 'OZ Timelock')
    ) {
      const batchTargets = params.targets ?? (params.target ? [params.target] : []);
      const n = batchTargets.length || (params.children?.length ?? 0);
      const verb = fn.startsWith('schedule') ? 'Scheduled' : 'Executed';
      const inner = await summarizeChildren(chain, params.children, tx);
      const detail = inner.length ? inner.join('; ') : `${n}-call batch`;
      return `${verb} ${n}-call batch: ${detail}`;
    }

    // ── Safe execTransaction ───────────────────────────────────────────────────
    if (fn === 'execTransaction' && protocol === 'Safe') {
      const inner = await summarizeChildren(chain, params.children, tx);
      const innerSummary = inner[0] ?? 'opaque call';
      return `Safe exec → ${params.to}: ${innerSummary}`;
    }

    // ── Gnosis MultiSend ──────────────────────────────────────────────────────
    if (fn === 'multiSend' && protocol === 'Gnosis MultiSend') {
      const packed = normalizeBytesToHex(params.transactions);
      let ops = [];
      try {
        ops = packed ? decodeMultiSend(packed) : [];
      } catch {
        ops = [];
      }
      const inner = await summarizeChildren(chain, params.children, tx);
      const detail = inner.length
        ? inner.join('; ')
        : ops.map(o => `→ ${o.to}`).join('; ');
      return `MultiSend ${ops.length} inner calls: ${detail}`;
    }
  } catch {
    // Summary build failed — fall through to generic
  }

  return `Called ${fn} on ${protocol}`;
}

// Recipient: account in keys[1..] with the largest positive lamport delta.
function pickSolanaTo(tx) {
  const keys = tx.accountKeys ?? [];
  const pre  = tx.preBalances ?? [];
  const post = tx.postBalances ?? [];
  if (keys.length === 0 || pre.length !== keys.length || post.length !== keys.length) return null;
  let bestIdx = -1;
  let bestDelta = 0n;
  for (let i = 1; i < keys.length; i++) {
    const delta = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
    if (delta > bestDelta) { bestDelta = delta; bestIdx = i; }
  }
  return bestIdx >= 0 ? (keys[bestIdx]?.pubkey ?? null) : null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Decode an EVM transaction, producing a rich human-readable result.
 *
 * @param {string} chain    - 'ethereum' | 'polygon' | 'arbitrum' | 'base'
 * @param {string} txHash   - 0x-prefixed transaction hash
 * @returns {Promise<DecodedTransaction>}
 */
/**
 * Decode calldata with nested children (exported for tests).
 */
export function decodeNestedCalldata(calldata, depth = 0, byteBudget = 0) {
  return decodeNested(calldata, depth, byteBudget);
}

/**
 * Build summary string from calldata without fetching a tx (exported for tests).
 */
export async function summarizeCalldata(chain, calldata, tx = null) {
  const nested = decodeNested(calldata, 0, 0);
  if (!nested.registryEntry) {
    const selector = calldata?.slice(0, 10) ?? '0x';
    return `Contract call with unknown selector ${selector}`;
  }
  return buildSummary(chain, nested.registryEntry, nested.params, tx);
}

export async function decodeTransaction(chain, txHash, opts = {}) {
  const rpcQuorum = opts.rpcQuorum ?? 'any';
  const raw       = opts.raw === true;
  const adapter = getChainAdapter(chain);
  if (!adapter) {
    if (raw) {
      return { __schema: 'glnc.tx-raw/v1', chain, hash: txHash, raw: null,
               error: `Unsupported chain: ${chain}` };
    }
    return {
      hash: txHash, chain, from: null, to: null,
      value: '0', gasUsed: '0', gasPriceGwei: '0',
      gasCostUsd: 'N/A', status: 'unknown',
      summary: `Unsupported chain: ${chain}`,
      raw: null,
      tokenMovements: [],
      approvals: [],
    };
  }

  // ── Solana / Bitcoin pass-through ─────────────────────────────────────────
  if (chain === 'solana') {
    if (raw) {
      const solRaw = await adapter.getTransaction({ signature: txHash, rpcQuorum, raw: true });
      // Solana adapter quorum.sources currently hold pre-stringified RPC results
      // (no BigInts), but apply jsonSafeQuorum for symmetry with the EVM raw path
      // so future adapter changes can't reintroduce the BigInt-serialize crash.
      return {
        __schema: 'glnc.tx-raw/v1',
        chain,
        hash:    txHash,
        raw:     solRaw.rawRpc ?? null,
        error:   solRaw.error ?? null,
        ...(solRaw.source !== undefined ? { source: solRaw.source } : {}),
        ...(solRaw.quorum !== undefined ? { quorum: jsonSafeQuorum(solRaw.quorum) } : {}),
      };
    }
    const solRes = await adapter.getTransaction({ signature: txHash, rpcQuorum });
    const { tx, error, source, slot, blockTime, quorum } = solRes;
    if (error || !tx) {
      return {
        hash: txHash, chain, from: null, to: null,
        value: '0', gasUsed: '0', gasPriceGwei: '0',
        gasCostUsd: 'N/A', status: 'unknown',
        summary: error ?? 'Transaction not found',
        raw: null,
        tokenMovements: [],
        approvals: [],
      };
    }
    const feeSol     = tx.fee ? fmt(BigInt(tx.fee), 9) : '0';
    const solPrice   = await getPrice('SOL');
    const feeCostUsd = solPrice > 0 ? `$${(parseFloat(feeSol) * solPrice).toFixed(4)}` : 'N/A';
    return {
      hash:         txHash,
      chain,
      from:         tx.accountKeys?.[0]?.pubkey ?? null,
      to:           pickSolanaTo(tx),
      value:        `${feeSol} SOL`,
      gasUsed:      '0',
      gasPriceGwei: '0',
      gasCostUsd:   feeCostUsd,
      status:       tx.status,
      summary:      `Solana transaction with fee ${feeSol} SOL`,
      raw:          { tx },
      tokenMovements: [],
      approvals:      [],
      ...(source    !== undefined ? { source }    : {}),
      ...(slot      !== undefined ? { slot }      : {}),
      ...(blockTime !== undefined ? { blockTime } : {}),
      ...(quorum    !== undefined ? { quorum: jsonSafeQuorum(quorum) } : {}),
    };
  }

  if (chain === 'bitcoin') {
    // Bitcoin adapter is not quorum-enabled; uses its own fallback logic.
    const { tx, error } = await adapter.getTransaction(txHash);
    if (error || !tx) {
      return {
        hash: txHash, chain, from: null, to: null,
        value: '0', gasUsed: '0', gasPriceGwei: '0',
        gasCostUsd: 'N/A', status: 'unknown',
        summary: error ?? 'Transaction not found',
        raw: null,
        tokenMovements: [],
        approvals: [],
      };
    }
    const btcPrice   = await getPrice('BTC');
    const feeBtcNum  = parseFloat(tx.feeBtc ?? '0');
    const feeCostUsd = btcPrice > 0 ? `$${(feeBtcNum * btcPrice).toFixed(4)}` : 'N/A';
    const totalOut   = (tx.outputs ?? []).reduce((s, o) => s + (o.value ?? 0n), 0n);

    // Pick the most prominent output address as "to"
    const toAddr = tx.outputs?.[0]?.address ?? null;
    const fromAddr = tx.inputs?.[0]?.address ?? null;

    return {
      hash:         txHash,
      chain,
      from:         fromAddr,
      to:           toAddr,
      value:        `${tx.feeBtc ?? '0'} BTC (fee)`,
      gasUsed:      String(tx.size ?? 0),
      gasPriceGwei: '0',
      gasCostUsd:   feeCostUsd,
      status:       tx.status,
      summary:      `Bitcoin transaction, ${formatBtc(totalOut < 0n ? 0n : totalOut)} BTC total output, fee ${tx.feeBtc ?? '0'} BTC`,
      raw:          { tx },
      tokenMovements: [],
      approvals:      [],
    };
  }

  // ── EVM chains ────────────────────────────────────────────────────────────
  const evmRes = await adapter.getTransaction({ hash: txHash, rpcQuorum });
  const { tx, receipt, error, source, blockNumber, quorum } = evmRes;

  if (raw) {
    // EVM adapters already return raw viem `tx`+`receipt`. Wrap them under the
    // tx-raw schema without going through the glnc.tx/v1 reshape pipeline.
    // The adapter's `quorum` block carries raw viem objects (with BigInts) inside
    // `sources[].value` and `disagreements[].value` — pass it through jsonSafeQuorum
    // so the downstream JSON.stringify cannot throw on a BigInt.
    return {
      __schema: 'glnc.tx-raw/v1',
      chain,
      hash:    txHash,
      raw:     error && !tx ? null : { tx: serializeBigInts(tx), receipt: serializeBigInts(receipt) },
      error:   error ?? null,
      ...(source      !== undefined ? { source }      : {}),
      ...(blockNumber !== undefined ? { blockNumber } : {}),
      ...(evmRes.quorum !== undefined ? { quorum: jsonSafeQuorum(evmRes.quorum) } : {}),
    };
  }

  if (error && !tx) {
    return {
      hash: txHash, chain, from: null, to: null,
      value: '0', gasUsed: '0', gasPriceGwei: '0',
      gasCostUsd: 'N/A', status: 'unknown',
      summary: error,
      raw: null,
      tokenMovements: [],
      approvals: [],
    };
  }

  // Parse gas cost
  const gasUsed      = receipt?.gasUsed      ?? 0n;
  const effectiveGasPrice = receipt?.effectiveGasPrice ?? tx?.gasPrice ?? 0n;
  const gasCostWei   = gasUsed * effectiveGasPrice;
  const gasCostEth   = parseFloat(fmt(gasCostWei, 18));
  const gasPriceGwei = fmt(effectiveGasPrice, 9);

  // Determine native asset symbol for this chain
  const nativeSymbol = chain === 'polygon' ? 'POL' : 'ETH';
  const nativeCoingeckoSym = chain === 'polygon' ? 'pol' : 'eth';

  const nativePrice  = await getPrice(nativeCoingeckoSym);
  const gasCostUsd   = nativePrice > 0
    ? `$${(gasCostEth * nativePrice).toFixed(4)}`
    : 'N/A';

  const value    = fmt(tx?.value ?? 0n, 18);
  const status   = receipt?.status === 'success' ? 'success'
    : receipt?.status === 'reverted'   ? 'failed'
    : !receipt                          ? 'pending'
    : 'unknown';

  // Decode calldata
  const calldata       = tx?.input ?? '0x';
  const registryEntry  = lookupSelector(calldata);
  let summary;
  let decodedParams = {};

  if (!calldata || calldata === '0x' || calldata === '0x0') {
    // Plain ETH transfer
    const ethAmt = value;
    summary = `Transferred ${ethAmt} ${nativeSymbol} to ${tx?.to ?? 'unknown'}`;
  } else if (registryEntry) {
    const nested = decodeNested(calldata, 0, 0);
    decodedParams = nested.params;
    summary = await buildSummary(chain, registryEntry, decodedParams, tx);
  } else {
    // Unknown selector
    const selector = calldata.slice(0, 10);
    summary = `Contract call with unknown selector ${selector} to ${tx?.to ?? 'unknown'}`;
  }

  // Decode event logs into token movements and approvals
  let tokenMovements = [];
  let approvals      = [];
  try {
    const eventsResult = await decodeReceiptLogs(chain, receipt, tx, getTokenMeta);
    tokenMovements = eventsResult.tokenMovements;
    approvals      = eventsResult.approvals;
  } catch {
    // Non-fatal — return empty arrays so the shape contract is always satisfied
  }

  // EVM tx blockTimestamp is not fetched by the adapter (would require an
  // extra eth_getBlockByNumber call per tx). We pass through whatever the
  // adapter provides — currently `blockNumber` only.
  return {
    hash:         txHash,
    chain,
    from:         tx?.from    ?? null,
    to:           tx?.to      ?? null,
    value:        `${value} ${nativeSymbol}`,
    gasUsed:      String(gasUsed),
    gasPriceGwei: gasPriceGwei,
    gasCostUsd,
    status,
    summary,
    tokenMovements,
    approvals,
    ...(source      !== undefined ? { source }      : {}),
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(quorum      !== undefined ? { quorum: jsonSafeQuorum(quorum) } : {}),
    raw: {
      tx:      serializeBigInts(tx),
      receipt: serializeBigInts(receipt),
      decoded: decodedParams ? serializeBigInts(decodedParams) : null,
    },
  };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Recursively convert BigInt values to strings so JSON.stringify works.
 */
function serializeBigInts(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(serializeBigInts);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = serializeBigInts(v);
    }
    return out;
  }
  return obj;
}
