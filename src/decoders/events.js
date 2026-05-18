/**
 * src/decoders/events.js
 *
 * Event-log decoder for EVM transactions.
 *
 * Exports:
 *   decodeReceiptLogs(chain, receipt, tx, tokenMetaResolver)
 *     => Promise<{ tokenMovements: TokenMovement[], approvals: Approval[] }>
 *
 * TokenMovement shape:
 * {
 *   direction:        'in' | 'out',
 *   amount:           string,           // decimal-formatted
 *   symbol:           string,
 *   counterparty:     string,           // the OTHER address
 *   counterpartyName: string | null,
 *   token:            string,           // contract address or 'native'
 *   rawAmount:        string,           // bigint as string
 * }
 *
 * Approval shape:
 * {
 *   spender:      string,
 *   spenderName:  string | null,
 *   symbol:       string,
 *   amount:       string,               // 'Unlimited' or decimal-formatted
 *   token:        string,
 * }
 */

import { decodeAbiParameters, formatUnits, getAddress } from 'viem';
import { KNOWN_CONTRACTS } from './registry.js';

// ─── Event topic[0] constants ─────────────────────────────────────────────────

const TOPIC_TRANSFER   = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TOPIC_APPROVAL   = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const TOPIC_WETH_DEP   = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const TOPIC_WETH_WITH  = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const TOPIC_TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const TOPIC_TRANSFER_BATCH  = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
// Informational only — we recognise these so we can skip double-counting.
const TOPIC_UNI_V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const TOPIC_UNI_V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

// ─── Per-chain WETH-equivalent addresses (lowercase) ─────────────────────────

const WRAPPED_NATIVE = {
  ethereum: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
  polygon:  '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', // WMATIC
  arbitrum: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH on Arbitrum
  base:     '0x4200000000000000000000000000000000000006', // WETH on Base
  optimism: '0x4200000000000000000000000000000000000006', // WETH on Optimism (OP-stack canonical)
  linea:    '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', // WETH on Linea
  zksync:   '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91', // WETH on zkSync Era
};

// Native symbol by chain
const NATIVE_SYMBOL = {
  ethereum: 'ETH',
  polygon:  'POL',
  arbitrum: 'ETH',
  base:     'ETH',
  optimism: 'ETH',
  linea:    'ETH',
  zksync:   'ETH',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a checksummed address from a 32-byte topic.
 * topics are '0x' + 64 hex chars; the address is the last 40 hex chars.
 */
function addrFromTopic(topic) {
  if (!topic || topic.length < 42) return null;
  try {
    return getAddress('0x' + topic.slice(-40));
  } catch {
    return null;
  }
}

/**
 * Decode a single uint256 from log.data.
 * Returns 0n on failure.
 */
function decodeUint256(data) {
  if (!data || data === '0x' || data.length < 66) return 0n;
  try {
    const [val] = decodeAbiParameters([{ type: 'uint256' }], data);
    return val;
  } catch {
    return 0n;
  }
}

/**
 * Format a bigint token amount. Defaults to 18 decimals.
 */
function fmtAmount(amount, decimals = 18) {
  return formatUnits(amount, decimals);
}

/**
 * Resolve a known-contract name from KNOWN_CONTRACTS (chain-scoped, lowercase keys).
 */
function resolveName(addr, chain) {
  if (!addr || !chain) return null;
  return KNOWN_CONTRACTS[chain]?.[addr.toLowerCase()] ?? null;
}

/**
 * Threshold for "unlimited" approval: 2^255.
 */
const UNLIMITED_THRESHOLD = 2n ** 255n;

// ─── Main decoder ─────────────────────────────────────────────────────────────

/**
 * Decode all event logs from a transaction receipt into structured arrays.
 *
 * @param {string}   chain             - 'ethereum' | 'polygon' | 'arbitrum' | 'base' | 'optimism' | 'linea' | 'zksync'
 * @param {object}   receipt           - viem receipt object (has .logs array)
 * @param {object}   tx                - raw tx object (has .from, .to, .value, .input)
 * @param {Function} tokenMetaResolver - async (chain, address) => { symbol, decimals } | null
 * @returns {Promise<{ tokenMovements: object[], approvals: object[] }>}
 */
export async function decodeReceiptLogs(chain, receipt, tx, tokenMetaResolver) {
  const tokenMovements = [];
  const approvals      = [];

  if (!receipt?.logs?.length) {
    // Synthesize a plain native transfer when there are no logs and value > 0
    const movements = synthesizeNativeTransfer(chain, tx);
    return { tokenMovements: movements, approvals };
  }

  const logs       = receipt.logs;
  const userRaw    = tx?.from ?? '';
  const user       = userRaw.toLowerCase();
  const nativeSym  = NATIVE_SYMBOL[chain] ?? 'ETH';
  const wethAddr   = WRAPPED_NATIVE[chain] ?? null;

  // ── Step 1: Collect unique contract addresses for batch meta lookup ──────────
  const contractAddrs = new Set();
  for (const log of logs) {
    if (log.address) contractAddrs.add(log.address.toLowerCase());
  }

  // Batch resolve token meta in parallel
  const metaMap = new Map(); // lowercase address → { symbol, decimals }
  await Promise.all(
    [...contractAddrs].map(async (addr) => {
      try {
        // Use the properly-checksummed address for the RPC call
        const checksummed = getAddress(addr);
        const meta = await tokenMetaResolver(chain, checksummed);
        if (meta) metaMap.set(addr, meta);
      } catch {
        // ignore — we'll fall back to address abbreviation
      }
    })
  );

  // ── Step 2: Identify WETH Deposit wads to suppress corresponding Transfers ──
  // We track (wad bigint) set from Deposit events so we can skip the Transfer
  // that immediately follows (user wrapping ETH sends a Transfer from user→router
  // for the same amount).
  const depositWads = new Set(); // stringified bigint wads from Deposit events where dst === user

  // First pass: collect deposit wads
  for (const log of logs) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    if (topic0 !== TOPIC_WETH_DEP) continue;
    const dst = addrFromTopic(log.topics[1]);
    if (!dst || dst.toLowerCase() !== user) continue;
    const wad = decodeUint256(log.data);
    depositWads.add(String(wad));
  }

  // ── Step 3: Process each log ─────────────────────────────────────────────────
  for (const log of logs) {
    try {
      const topic0 = log.topics?.[0]?.toLowerCase();
      if (!topic0) continue;

      // Skip informational Uniswap swap events (we get movements from Transfers)
      if (topic0 === TOPIC_UNI_V2_SWAP || topic0 === TOPIC_UNI_V3_SWAP) continue;

      const contractAddr = log.address?.toLowerCase() ?? '';
      const meta         = metaMap.get(contractAddr);

      // ── ERC20 / ERC721 Transfer ─────────────────────────────────────────────
      if (topic0 === TOPIC_TRANSFER) {
        const topicCount = log.topics.length;

        if (topicCount === 3) {
          // ERC20 Transfer(address indexed from, address indexed to, uint256 value)
          const from  = addrFromTopic(log.topics[1]);
          const to    = addrFromTopic(log.topics[2]);
          if (!from || !to) continue;

          const fromLow = from.toLowerCase();
          const toLow   = to.toLowerCase();
          const value   = decodeUint256(log.data);

          // Skip internal hops that don't involve the user
          if (fromLow !== user && toLow !== user) continue;

          // Suppress only the canonical zero→user mint Transfer; user→anywhere is a legitimate movement.
          const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
          if (
            fromLow === ZERO_ADDR &&
            toLow === user &&
            contractAddr === wethAddr?.toLowerCase() &&
            depositWads.has(String(value))
          ) {
            depositWads.delete(String(value)); // consume once
            continue;
          }

          const symbol   = meta?.symbol   ?? abbreviateAddr(log.address);
          // BUG 25: when meta is missing we can't assume 18 decimals (e.g. USDT=6); flag for downstream.
          const decimalsUnknown = !meta || meta.decimals == null;
          const rawAmount = String(value);
          const amount    = decimalsUnknown ? rawAmount : fmtAmount(value, meta.decimals);

          if (fromLow === user) {
            // User sent tokens out
            tokenMovements.push({
              direction:        'out',
              amount,
              symbol,
              counterparty:     to,
              counterpartyName: resolveName(to, chain),
              token:            log.address,
              rawAmount,
              ...(decimalsUnknown ? { decimalsUnknown: true } : {}),
            });
          } else {
            // User received tokens
            tokenMovements.push({
              direction:        'in',
              amount,
              symbol,
              counterparty:     from,
              counterpartyName: resolveName(from, chain),
              token:            log.address,
              rawAmount,
              ...(decimalsUnknown ? { decimalsUnknown: true } : {}),
            });
          }

        } else if (topicCount === 4) {
          // ERC721 Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
          const from    = addrFromTopic(log.topics[1]);
          const to      = addrFromTopic(log.topics[2]);
          const tokenId = addrFromTopic(log.topics[3]); // last 40 hex = numeric id

          if (!from || !to) continue;

          const fromLow = from.toLowerCase();
          const toLow   = to.toLowerCase();
          if (fromLow !== user && toLow !== user) continue;

          // Parse tokenId from topic (it's a uint256 packed as 32 bytes)
          let tokenIdNum = 'unknown';
          try {
            tokenIdNum = String(BigInt('0x' + log.topics[3].slice(-64)));
          } catch { /* ignore */ }

          const nftName = meta?.symbol ? `${meta.symbol}-NFT` : 'NFT';
          const amount  = `#${tokenIdNum}`;

          if (fromLow === user) {
            tokenMovements.push({
              direction:        'out',
              amount,
              symbol:           nftName,
              counterparty:     to,
              counterpartyName: resolveName(to, chain),
              token:            log.address,
              rawAmount:        tokenIdNum,
            });
          } else {
            tokenMovements.push({
              direction:        'in',
              amount,
              symbol:           nftName,
              counterparty:     from,
              counterpartyName: resolveName(from, chain),
              token:            log.address,
              rawAmount:        tokenIdNum,
            });
          }
        }
        continue;
      }

      // ── ERC-1155 TransferSingle ─────────────────────────────────────────────
      if (topic0 === TOPIC_TRANSFER_SINGLE) {
        const from = addrFromTopic(log.topics[2]);
        const to   = addrFromTopic(log.topics[3]);
        if (!from || !to) continue;

        const fromLow = from.toLowerCase();
        const toLow   = to.toLowerCase();
        if (fromLow !== user && toLow !== user) continue;

        let id = 0n, value = 0n;
        try {
          [id, value] = decodeAbiParameters(
            [{ type: 'uint256' }, { type: 'uint256' }],
            log.data
          );
        } catch { continue; }

        const symbol = meta?.symbol ? `${meta.symbol}-NFT` : 'NFT-1155';
        const amount = `${value}× #${id}`;
        const rawAmount = String(value);

        if (fromLow === user) {
          tokenMovements.push({
            direction: 'out', amount, symbol,
            counterparty: to, counterpartyName: resolveName(to, chain),
            token: log.address, rawAmount,
          });
        } else {
          tokenMovements.push({
            direction: 'in', amount, symbol,
            counterparty: from, counterpartyName: resolveName(from, chain),
            token: log.address, rawAmount,
          });
        }
        continue;
      }

      // ── ERC-1155 TransferBatch ──────────────────────────────────────────────
      if (topic0 === TOPIC_TRANSFER_BATCH) {
        const from = addrFromTopic(log.topics[2]);
        const to   = addrFromTopic(log.topics[3]);
        if (!from || !to) continue;

        const fromLow = from.toLowerCase();
        const toLow   = to.toLowerCase();
        if (fromLow !== user && toLow !== user) continue;

        let ids = [], values = [];
        try {
          [ids, values] = decodeAbiParameters(
            [{ type: 'uint256[]' }, { type: 'uint256[]' }],
            log.data
          );
        } catch { continue; }
        if (ids.length !== values.length) continue;

        const symbol = meta?.symbol ? `${meta.symbol}-NFT` : 'NFT-1155';
        const direction = fromLow === user ? 'out' : 'in';
        const counterparty = fromLow === user ? to : from;
        const counterpartyName = resolveName(counterparty, chain);

        // For huge batches, emit one summary entry to avoid log-list explosion.
        if (ids.length > 20) {
          const totalCount = values.reduce((acc, v) => acc + v, 0n);
          tokenMovements.push({
            direction, amount: `${totalCount}× (${ids.length} ids)`, symbol,
            counterparty, counterpartyName,
            token: log.address, rawAmount: String(totalCount),
          });
        } else {
          for (let i = 0; i < ids.length; i++) {
            tokenMovements.push({
              direction,
              amount: `${values[i]}× #${ids[i]}`,
              symbol,
              counterparty, counterpartyName,
              token: log.address,
              rawAmount: String(values[i]),
            });
          }
        }
        continue;
      }

      // ── ERC20 Approval ──────────────────────────────────────────────────────
      if (topic0 === TOPIC_APPROVAL) {
        const owner   = addrFromTopic(log.topics[1]);
        const spender = addrFromTopic(log.topics[2]);
        if (!owner || !spender) continue;
        if (owner.toLowerCase() !== user) continue;

        const value    = decodeUint256(log.data);
        const symbol   = meta?.symbol   ?? abbreviateAddr(log.address);
        // BUG 25: don't fall back to 18 decimals when meta is missing — flag instead.
        const decimalsUnknown = !meta || meta.decimals == null;

        let amount;
        if (value >= UNLIMITED_THRESHOLD) {
          amount = 'Unlimited';
        } else if (decimalsUnknown) {
          amount = String(value);
        } else {
          amount = fmtAmount(value, meta.decimals);
        }

        approvals.push({
          spender,
          spenderName: resolveName(spender, chain),
          symbol,
          amount,
          token: log.address,
          ...(decimalsUnknown && value < UNLIMITED_THRESHOLD ? { decimalsUnknown: true } : {}),
        });
        continue;
      }

      // ── WETH Deposit ────────────────────────────────────────────────────────
      if (topic0 === TOPIC_WETH_DEP) {
        const dst = addrFromTopic(log.topics[1]);
        if (!dst || dst.toLowerCase() !== user) continue;

        const wad = decodeUint256(log.data);

        // Only synthesize native movement if tx.value matches the deposit wad
        // (guards against indirect deposit events from internal calls)
        const txValue = tx?.value ?? 0n;
        if (wad !== txValue && txValue !== 0n) continue;

        const amount = fmtAmount(wad, 18);

        // Synthetic ETH-out: user wrapped their ETH
        tokenMovements.push({
          direction:        'out',
          amount,
          symbol:           nativeSym,
          counterparty:     log.address, // WETH contract
          counterpartyName: resolveName(log.address, chain),
          token:            'native',
          rawAmount:        String(wad),
        });
        continue;
      }

      // ── WETH Withdrawal ─────────────────────────────────────────────────────
      if (topic0 === TOPIC_WETH_WITH) {
        const src = addrFromTopic(log.topics[1]);
        if (!src) continue;
        if (user === '') continue;

        // Only synthesize ETH-in when the user themselves called withdraw.
        // Router-mediated unwraps (src=router) cannot be confirmed without
        // internal-tx data; emitting them was over-attributing native ETH
        // receipts to users on every router swap that ended in unwrap.
        if (src.toLowerCase() !== user) continue;

        const wad    = decodeUint256(log.data);
        const amount = fmtAmount(wad, 18);

        tokenMovements.push({
          direction:        'in',
          amount,
          symbol:           nativeSym,
          counterparty:     src,
          counterpartyName: resolveName(src, chain),
          token:            'native',
          rawAmount:        String(wad),
        });
        continue;
      }

    } catch {
      // Skip malformed logs gracefully
      continue;
    }
  }

  // ── Synthesize plain native transfer (no logs, value > 0, empty calldata) ───
  if (tokenMovements.length === 0 && approvals.length === 0) {
    const synthetic = synthesizeNativeTransfer(chain, tx);
    tokenMovements.push(...synthetic);
  }

  return { tokenMovements, approvals };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Produce a synthetic tokenMovement for a plain ETH/native transfer
 * when tx.value > 0 and calldata is empty (0x).
 */
function synthesizeNativeTransfer(chain, tx) {
  if (!tx) return [];
  const value = tx.value ?? 0n;
  if (value === 0n) return [];
  const calldata = tx.input ?? '0x';
  if (calldata !== '0x' && calldata !== '0x0' && calldata !== '') return [];

  const nativeSym = NATIVE_SYMBOL[chain] ?? 'ETH';
  const amount    = fmtAmount(value, 18);

  return [{
    direction:        'out',
    amount,
    symbol:           nativeSym,
    counterparty:     tx.to ?? '',
    counterpartyName: tx.to ? resolveName(tx.to, chain) : null,
    token:            'native',
    rawAmount:        String(value),
  }];
}

/**
 * Abbreviate an address to '0xabcd…1234' for use as a fallback symbol.
 */
function abbreviateAddr(addr) {
  if (!addr || addr.length < 10) return addr ?? 'unknown';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
