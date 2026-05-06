/**
 * src/history/classifier.js
 *
 * Combine raw normal/internal/token-tx rows from Etherscan and produce one
 * normalized Row per txHash. Pure — no network calls. Heuristics are
 * deliberately pragmatic: predictable v1 over clever-but-fragile.
 */

import { formatUnits } from 'viem';

const APPROVE_SELECTOR = '0x095ea7b3'; // ERC20 approve(address,uint256)
const NATIVE_DECIMALS = 18;

/**
 * Native gas-token symbol for a given chain.
 * @param {string} chain
 * @returns {string} 'ETH' | 'POL'
 */
export function nativeSymbol(chain) {
  return chain === 'polygon' ? 'POL' : 'ETH';
}

function fmt(raw, decimals) {
  if (raw === null || raw === undefined || raw === '') return '0';
  try { return formatUnits(BigInt(raw), Number(decimals) || 0); }
  catch { return '0'; }
}

// ISO without millis for cleaner CSV output.
function isoUtc(sec) {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function groupByHash(rows) {
  const m = new Map();
  for (const r of rows) {
    const h = r.hash;
    if (!h) continue;
    if (!m.has(h)) m.set(h, []);
    m.get(h).push(r);
  }
  return m;
}

// Only the sender pays gas; receivers get null.
function computeFeeNative(normalTx, userAddr) {
  if (!normalTx || normalTx.from !== userAddr) return null;
  try {
    const fee = BigInt(normalTx.gasUsed ?? '0') * BigInt(normalTx.gasPrice ?? '0');
    return formatUnits(fee, NATIVE_DECIMALS);
  } catch { return null; }
}

function makeBaseRow({ chain, hash, blockNumber, timestamp }) {
  return {
    timestamp,
    isoTimestamp:     isoUtc(timestamp),
    chain,
    txHash:           hash,
    blockNumber,
    type:             'other',
    tokenIn:          null,
    amountIn:         null,
    tokenOut:         null,
    amountOut:        null,
    counterparty:     null,
    counterpartyName: null,
    feeNative:        null,
    feeSymbol:        null,
    contract:         null,
    method:           null,
    rawTokenContract: null,
    usdValue:         null,
    feeUsd:           null,
  };
}

function classifyOne({ chain, address, hash, normals, internals, tokens }) {
  const userAddr = address;
  const native   = nativeSymbol(chain);

  // Normal tx is canonical for timestamp/block/gas. Synthesize from any row
  // when absent (rare — happens for receive-only ERC20 not paginated to us).
  const normalTx = normals[0] ?? null;
  const anyRow   = normalTx ?? internals[0] ?? tokens[0] ?? null;
  const timestamp   = (normalTx?.timeStamp ?? anyRow?.timeStamp ?? 0) | 0;
  const blockNumber = parseInt(normalTx?.blockNumber ?? anyRow?.blockNumber ?? '0', 10) || 0;

  const row = makeBaseRow({ chain, hash, blockNumber, timestamp });

  const feeNative = computeFeeNative(normalTx, userAddr);
  if (feeNative !== null) {
    row.feeNative = feeNative;
    row.feeSymbol = native;
  }
  row.contract = normalTx?.to ?? null;

  const tokenOuts = tokens.filter(t => t.from === userAddr);
  const tokenIns  = tokens.filter(t => t.to   === userAddr);

  const nativeSentByUser = normalTx && normalTx.from === userAddr
    ? BigInt(normalTx.value ?? '0') : 0n;
  const nativeReceivedByUser = internals
    .filter(i => i.to === userAddr)
    .reduce((acc, i) => { try { return acc + BigInt(i.value ?? '0'); } catch { return acc; } }, 0n);

  const userIsSender = !!(normalTx && normalTx.from === userAddr);
  const input = (normalTx?.input ?? '0x').toLowerCase();
  const selector = input.slice(0, 10);

  // Counterparty — best-effort "other side" of the most informative movement.
  if (tokenOuts.length > 0 && tokenIns.length === 0) {
    row.counterparty = tokenOuts[0].to ?? null;
  } else if (tokenIns.length > 0 && tokenOuts.length === 0) {
    row.counterparty = tokenIns[0].from ?? null;
  } else if (normalTx) {
    row.counterparty = userIsSender ? (normalTx.to ?? null) : (normalTx.from ?? null);
  }

  // Approve — short-circuit when it's a clean approve call.
  if (selector === APPROVE_SELECTOR && tokenOuts.length === 0 && tokenIns.length === 0) {
    row.type = 'approve';
    row.rawTokenContract = normalTx?.to ?? null;
    return row;
  }

  // Swap — multi-hop: first OUT is what user paid, last IN is what they got.
  if (tokenOuts.length >= 1 && tokenIns.length >= 1 && userIsSender) {
    const paid     = tokenOuts[0];
    const received = tokenIns[tokenIns.length - 1];
    row.type      = 'swap';
    row.tokenIn   = paid.tokenSymbol ?? null;
    row.amountIn  = fmt(paid.value, paid.tokenDecimal);
    row.tokenOut  = received.tokenSymbol ?? null;
    row.amountOut = fmt(received.value, received.tokenDecimal);
    row.rawTokenContract = received.contractAddress ?? paid.contractAddress ?? null;
    return row;
  }

  // Wrap — user sent native AND received a W* token from the same contract.
  if (userIsSender && nativeSentByUser > 0n && tokenIns.length === 1) {
    const got = tokenIns[0];
    const sym = (got.tokenSymbol ?? '').toUpperCase();
    if (sym.startsWith('W') && got.contractAddress === (normalTx?.to ?? null)) {
      row.type      = 'wrap';
      row.tokenIn   = native;
      row.amountIn  = formatUnits(nativeSentByUser, NATIVE_DECIMALS);
      row.tokenOut  = got.tokenSymbol ?? null;
      row.amountOut = fmt(got.value, got.tokenDecimal);
      row.rawTokenContract = got.contractAddress ?? null;
      return row;
    }
  }

  // Unwrap — user sent W* and received native via internal tx.
  if (userIsSender && tokenOuts.length === 1 && nativeReceivedByUser > 0n) {
    const sent = tokenOuts[0];
    const sym  = (sent.tokenSymbol ?? '').toUpperCase();
    if (sym.startsWith('W') && sent.to === (normalTx?.to ?? null)) {
      row.type      = 'unwrap';
      row.tokenIn   = sent.tokenSymbol ?? null;
      row.amountIn  = fmt(sent.value, sent.tokenDecimal);
      row.tokenOut  = native;
      row.amountOut = formatUnits(nativeReceivedByUser, NATIVE_DECIMALS);
      row.rawTokenContract = sent.contractAddress ?? null;
      return row;
    }
  }

  // One-sided ERC20 transfers. Per spec: tokenIn/amountIn = the token sent
  // for transfer-out; tokenOut/amountOut = the token received for transfer-in.
  if (tokenOuts.length >= 1 && tokenIns.length === 0 && userIsSender) {
    const sent = tokenOuts[0];
    row.type     = 'transfer-out';
    row.tokenIn  = sent.tokenSymbol ?? null;
    row.amountIn = fmt(sent.value, sent.tokenDecimal);
    row.rawTokenContract = sent.contractAddress ?? null;
    return row;
  }
  if (tokenIns.length >= 1 && tokenOuts.length === 0) {
    const got = tokenIns[0];
    row.type      = 'transfer-in';
    row.tokenOut  = got.tokenSymbol ?? null;
    row.amountOut = fmt(got.value, got.tokenDecimal);
    row.rawTokenContract = got.contractAddress ?? null;
    return row;
  }

  // Plain native send (empty input, value > 0, user is sender).
  if (userIsSender && nativeSentByUser > 0n && (input === '0x' || input === '0x0' || input === '')) {
    row.type     = 'native-transfer-out';
    row.tokenIn  = native;
    row.amountIn = formatUnits(nativeSentByUser, NATIVE_DECIMALS);
    return row;
  }

  // Native receive via internal tx and no token movement.
  if (!userIsSender && nativeReceivedByUser > 0n && tokenIns.length === 0 && tokenOuts.length === 0) {
    row.type      = 'native-transfer-in';
    row.tokenOut  = native;
    row.amountOut = formatUnits(nativeReceivedByUser, NATIVE_DECIMALS);
    return row;
  }

  row.type = 'contract-call';
  return row;
}

/**
 * Combine the three Etherscan row arrays into normalized output rows.
 * Output is sorted ascending by (timestamp, txHash) for deterministic CSV.
 *
 * @param {object} args
 * @param {string} args.chain
 * @param {string} args.address  - lowercase
 * @param {object[]} args.normalTxs
 * @param {object[]} args.internalTxs
 * @param {object[]} args.tokenTxs
 * @returns {object[]} sorted by timestamp ascending
 */
export function classifyTransactions(args) {
  const { chain, address, normalTxs = [], internalTxs = [], tokenTxs = [] } = args;
  const userAddr = (address ?? '').toLowerCase();

  // Inclusive union over hash keys so we don't miss receive-only txs that
  // have no row in `normalTxs`.
  const normalsByHash   = groupByHash(normalTxs);
  const internalsByHash = groupByHash(internalTxs);
  const tokensByHash    = groupByHash(tokenTxs);

  const allHashes = new Set([
    ...normalsByHash.keys(),
    ...internalsByHash.keys(),
    ...tokensByHash.keys(),
  ]);

  const rows = [];
  for (const hash of allHashes) {
    rows.push(classifyOne({
      chain,
      address:   userAddr,
      hash,
      normals:   normalsByHash.get(hash)   ?? [],
      internals: internalsByHash.get(hash) ?? [],
      tokens:    tokensByHash.get(hash)    ?? [],
    }));
  }

  rows.sort((a, b) => (a.timestamp - b.timestamp) || a.txHash.localeCompare(b.txHash));
  return rows;
}
