/**
 * src/cli/render.js
 *
 * Terminal rendering helpers — table layout, summary blocks.
 * Color/style primitives live in ./theme.js; import from there, never use
 * raw ANSI escape sequences here.
 */

import { c, theme, chainBadge } from './theme.js';
import { SELECTOR_MAP, KNOWN_CONTRACTS } from '../decoders/registry.js';

// ---------------------------------------------------------------------------
// Visible-length helpers (ANSI-aware)
// ---------------------------------------------------------------------------

/**
 * Strip ANSI escape codes to get true display length.
 *
 * @param {string} s
 * @returns {number}
 */
export function visibleLen(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').length;
}

/**
 * Pad a string on the right to `width` visible characters.
 *
 * @param {string} s
 * @param {number} width
 * @returns {string}
 */
function padRight(s, width) {
  const pad = width - visibleLen(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/**
 * Pad a string on the left to `width` visible characters.
 *
 * @param {string} s
 * @param {number} width
 * @returns {string}
 */
function padLeft(s, width) {
  const pad = width - visibleLen(s);
  return pad > 0 ? ' '.repeat(pad) + s : s;
}

// ---------------------------------------------------------------------------
// Address formatting (Task 9)
// ---------------------------------------------------------------------------

/**
 * Format a blockchain address for display.
 *
 * EVM / BTC (0x or bech32): first 6 + … + last 4
 * Solana base58 (no 0x, length 32-44): first 4 + … + last 4
 * With verbose=true: return full address unchanged.
 *
 * @param {string} addr
 * @param {{ verbose?: boolean }} [opts]
 * @returns {string}
 */
export function formatAddress(addr, opts = {}) {
  if (!addr || typeof addr !== 'string') return addr ?? '—';
  if (opts.verbose) return addr;

  // Solana base58: no 0x prefix, base58 chars, 32-44 length
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  if (isSolana) {
    return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
  }

  // EVM (0x...) and Bitcoin (bc1..., 1..., 3...): first 6 + … + last 4
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Multi-line spinner (Task 11)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Creates a multi-line spinner with one row per chain.
 *
 * @param {string[]} chains  - chain names to display
 * @returns {{ update: (chain: string, status: 'pending'|'ok'|'fail', ms?: number) => void, stop: () => void }}
 */
export function createMultiSpinner(chains) {
  const isTTY = process.stderr.isTTY ?? false;

  // State per chain
  const state = new Map(chains.map(ch => [ch, { status: 'pending', ms: null }]));
  let frame = 0;
  let interval = null;

  // Maximum chain name length for alignment
  const maxLen = Math.max(...chains.map(ch => ch.length));

  function buildLine(chain) {
    const s = state.get(chain) ?? { status: 'pending', ms: null };
    let icon;
    if (s.status === 'ok')   icon = c.green('✓');
    else if (s.status === 'fail') icon = c.red('✗');
    else icon = theme.role.accent(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);

    const name = chain.padEnd(maxLen, ' ');

    let info;
    if (s.status === 'ok')   info = c.dim(`${s.ms}ms`);
    else if (s.status === 'fail') info = c.red('failed');
    else info = c.dim('fetching...');

    return `  ${icon} ${name}  ${info}`;
  }

  if (isTTY) {
    // Initial render — write all lines
    for (const ch of chains) {
      process.stderr.write(buildLine(ch) + '\x1b[K\n');
    }

    interval = setInterval(() => {
      frame++;
      // Move cursor up N lines, rewrite each
      process.stderr.write(`\x1b[${chains.length}A`);
      for (const ch of chains) {
        process.stderr.write(buildLine(ch) + '\x1b[K\n');
      }
    }, 80);
  } else {
    // Non-TTY: just print "fetching X..." lines
    for (const ch of chains) {
      process.stderr.write(c.dim(`  fetching ${ch}...\n`));
    }
  }

  return {
    update(chain, status, ms) {
      const entry = state.get(chain);
      if (!entry) return;
      entry.status = status;
      entry.ms = ms ?? null;

      if (!isTTY) {
        const icon = status === 'ok' ? c.green('✓') : c.red('✗');
        const info = status === 'ok' && ms != null ? ` (${ms}ms)` : '';
        process.stderr.write(`  ${icon} ${chain}${info}\n`);
      }
      // TTY redraw is handled by the interval
    },

    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (isTTY) {
        // Final redraw so last frame is correct
        process.stderr.write(`\x1b[${chains.length}A`);
        for (const ch of chains) {
          process.stderr.write(buildLine(ch) + '\x1b[K\n');
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy single-line spinner (kept for runTx usage)
// ---------------------------------------------------------------------------

/**
 * Creates a simple in-line spinner that writes to stderr.
 *
 * @param {string} initialMsg
 * @returns {{ update: (msg: string) => void, stop: (finalMsg?: string) => void }}
 */
export function createSpinner(initialMsg) {
  const isTTY = process.stderr.isTTY ?? false;
  let frame = 0;
  let interval = null;
  let current = initialMsg;

  const render = () => {
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    process.stderr.write(`\r${theme.role.accent(spinner)} ${current}   `);
    frame++;
  };

  if (isTTY) {
    render();
    interval = setInterval(render, 80);
  } else {
    process.stderr.write(`${current}\n`);
  }

  return {
    update(msg) {
      current = msg;
      if (!isTTY) process.stderr.write(`${msg}\n`);
    },
    stop(finalMsg) {
      if (interval) clearInterval(interval);
      if (isTTY) process.stderr.write('\r\x1b[K');
      if (finalMsg) process.stderr.write(`${finalMsg}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Progress lines (non-TTY-friendly)
// ---------------------------------------------------------------------------

/** @param {string} chain */
export function printFetching(chain) {
  process.stderr.write(c.dim(`  fetching ${chain}...\n`));
}

/**
 * @param {string} chain
 * @param {boolean} ok
 */
export function printFetchDone(chain, ok) {
  const icon = ok ? c.green('✓') : c.red('✗');
  process.stderr.write(c.dim(`  ${icon} ${chain}\n`));
}

// ---------------------------------------------------------------------------
// Amount / USD formatters
// ---------------------------------------------------------------------------

/**
 * Format a numeric token amount to a readable string.
 *
 * @param {string|number} amount
 * @param {number} [decimals=18]
 * @returns {string}
 */
export function formatAmount(amount, decimals = 18) {
  if (amount === undefined || amount === null) return '—';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(n)) return String(amount);
  const fixed = n.toFixed(Math.min(decimals, 6));
  return parseFloat(fixed).toLocaleString('en-US', {
    maximumFractionDigits: 6,
    minimumFractionDigits: 0,
  });
}

/**
 * Format a USD value.
 *
 * @param {number|null|undefined} usd
 * @returns {string}
 */
export function formatUsd(usd) {
  if (usd === null || usd === undefined || isNaN(usd)) return c.dim('—');
  return '$' + usd.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ---------------------------------------------------------------------------
// Generic table renderer (Task 10)
// ---------------------------------------------------------------------------

/**
 * Render a simple padded table to stdout.
 *
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {{
 *   rightAlign?: boolean[],
 *   decimalAlign?: number[],
 *   maxWidth?: number,
 * } | boolean[]} [opts]  - opts can also be the legacy rightAlign boolean[] for back-compat
 */
export function renderTable(headers, rows, opts = {}) {
  // Back-compat: if opts is a plain array, treat as rightAlign
  let rightAlign = [];
  let decimalAlign = [];
  let maxWidth = process.stdout.columns ?? 80;

  if (Array.isArray(opts)) {
    rightAlign = opts;
  } else {
    rightAlign   = opts.rightAlign   ?? [];
    decimalAlign = opts.decimalAlign ?? [];
    maxWidth     = opts.maxWidth     ?? maxWidth;
  }

  const colCount = headers.length;

  // ── Decimal alignment preprocessing ───────────────────────────────────────
  // For decimal-aligned columns, pre-compute the max integer/fractional widths
  // so all cells can be padded to align on the dot.
  const decAlignData = {}; // colIdx → { maxInt, maxFrac }
  for (const ci of decimalAlign) {
    let maxInt = 0;
    let maxFrac = 0;
    for (const row of rows) {
      const raw = visibleLen(row[ci] ?? '') > 0 ? row[ci] : '';
      // Strip ANSI from the cell value for splitting
      // eslint-disable-next-line no-control-regex
      const plain = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
      const dotIdx = plain.indexOf('.');
      if (dotIdx === -1) {
        maxInt = Math.max(maxInt, plain.length);
      } else {
        maxInt  = Math.max(maxInt,  dotIdx);
        maxFrac = Math.max(maxFrac, plain.length - dotIdx - 1);
      }
    }
    // Also check header
    const hPlain = headers[ci].replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
    maxInt = Math.max(maxInt, hPlain.length);
    decAlignData[ci] = { maxInt, maxFrac };
  }

  /**
   * Format a cell that should be decimal-aligned.
   * Returns the formatted string, padded for alignment on the decimal point.
   */
  function fmtDecCell(raw, ci) {
    const { maxInt, maxFrac } = decAlignData[ci];
    // eslint-disable-next-line no-control-regex
    const plain = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
    const dotIdx = plain.indexOf('.');
    // Non-numeric cells (—, N/A, etc.) — pad to full column width without inserting a dot
    if (dotIdx === -1 && !/\d/.test(plain)) {
      const fullWidth = maxFrac > 0 ? maxInt + 1 + maxFrac : maxInt;
      return plain.padStart(fullWidth);
    }
    let intPart, fracPart;
    if (dotIdx === -1) {
      intPart  = plain;
      fracPart = '';
    } else {
      intPart  = plain.slice(0, dotIdx);
      fracPart = plain.slice(dotIdx + 1);
    }
    // Pad int part to the right (right-align integers), frac part to left
    const paddedInt  = intPart.padStart(maxInt);
    const paddedFrac = fracPart.padEnd(maxFrac);
    return maxFrac > 0
      ? paddedInt + '.' + paddedFrac
      : paddedInt;
  }

  // ── Compute base column widths ─────────────────────────────────────────────
  const widths = Array.from({ length: colCount }, (_, i) => {
    if (decAlignData[i]) {
      const { maxInt, maxFrac } = decAlignData[i];
      const hLen = visibleLen(headers[i]);
      const dataWidth = maxFrac > 0 ? maxInt + 1 + maxFrac : maxInt;
      return Math.max(hLen, dataWidth);
    }
    const headerLen = visibleLen(headers[i]);
    const rowMax = rows.reduce((max, row) => Math.max(max, visibleLen(row[i] ?? '')), 0);
    return Math.max(headerLen, rowMax);
  });

  // ── Terminal-width clamping ────────────────────────────────────────────────
  const SEP_W = 2; // '  ' between columns
  const INDENT = 2; // leading '  '
  const totalW = () => INDENT + widths.reduce((s, w) => s + w, 0) + SEP_W * (colCount - 1);

  // Find widest non-numeric (non-rightAlign, non-decimalAlign) column to truncate
  while (totalW() > maxWidth) {
    let worstIdx = -1;
    let worstW   = 0;
    for (let i = 0; i < colCount; i++) {
      if (!rightAlign[i] && !decimalAlign.includes(i) && widths[i] > worstW) {
        worstW   = widths[i];
        worstIdx = i;
      }
    }
    if (worstIdx === -1) break; // can't shrink further
    widths[worstIdx]--;
  }

  const sep = '  ';

  // ── Header ─────────────────────────────────────────────────────────────────
  const headerLine = headers
    .map((h, i) => padRight(c.bold(h), widths[i]))
    .join(sep);
  console.log('  ' + headerLine);

  // ── Divider ────────────────────────────────────────────────────────────────
  const divider = widths.map(w => '─'.repeat(w)).join('──');
  console.log('  ' + c.dim(divider));

  // ── Data rows ──────────────────────────────────────────────────────────────
  for (const row of rows) {
    const line = row
      .map((cell, i) => {
        const raw = cell ?? '';
        const w   = widths[i];

        if (decAlignData[i]) {
          const formatted = fmtDecCell(raw, i);
          // Right-pad (or left-pad for numeric) to column width
          return padRight(formatted, w);
        }

        // Truncate if cell exceeds width (happens when we shrank a column)
        // eslint-disable-next-line no-control-regex
        const plain = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
        const truncated = plain.length > w
          ? raw.slice(0, w - 1) + '…'
          : raw;

        return rightAlign[i] ? padLeft(truncated, w) : padRight(truncated, w);
      })
      .join(sep);
    console.log('  ' + line);
  }
}

// ---------------------------------------------------------------------------
// Balance rendering
// ---------------------------------------------------------------------------

/**
 * @typedef {{ symbol: string, amount: string|number, decimals?: number, contract?: string }} TokenRow
 * @typedef {{ chain: string, native: TokenRow, tokens: TokenRow[], error: string|null }} ChainBalance
 */

/**
 * Render balance results for one or more chains to stdout.
 *
 * @param {Array<{ result: ChainBalance|null, error: Error|null, chain: string }>} results
 * @param {Record<string, number>} prices
 * @param {{
 *   verbose?: boolean,
 *   deltas?: Map<string, { prev: string, curr: string }>,
 *   positions?: any,
 *   nfts?: any,
 * }} [opts]
 */
export function renderBalances(results, prices, opts = {}) {
  let grandTotalUsd = 0;
  let grandTotalKnown = true;

  // deltas: Map<'chain:SYMBOL', { prev: string, curr: string }>
  const deltas = opts.deltas instanceof Map ? opts.deltas : null;

  for (const { result, error, chain } of results) {
    console.log('');

    if (error || !result || result.error) {
      // On error, show badge without token count then print the error
      console.log('  ' + chainBadge(chain));
      const msg = error?.message ?? result?.error ?? 'Unknown error';
      console.log(`  ${c.red('Error:')} ${msg}`);
      continue;
    }

    // Count non-zero-balance tokens (post-filter, native excluded from count)
    const visibleTokens = (result.tokens ?? []).filter(t => {
      const n = typeof t.amount === 'string' ? parseFloat(t.amount) : t.amount;
      return !isNaN(n) && n > 0;
    });
    const tokenCountSuffix = visibleTokens.length > 0
      ? `  ${c.dim(`(${visibleTokens.length} tokens)`)}`
      : '';

    // Task 7: per-chain colored badge with optional token count
    console.log('  ' + chainBadge(chain) + tokenCountSuffix);

    /** @type {Array<{ asset: string, amount: string, usdValue: string, rawUsd: number|null }>} */
    const rows = [];

    /**
     * @param {string}         symbol
     * @param {string|number}  amount
     * @param {number}         decimals
     * @param {string|null}    contract
     * @param {boolean}        [noPrice]  - true when price is genuinely unknown (not zero)
     */
    const addRow = (symbol, amount, decimals, contract, noPrice = false) => {
      const fmtAmt  = formatAmount(amount, decimals);
      const price   = prices[symbol.toUpperCase()];
      let rawUsd    = null;
      let usdStr;

      if (noPrice) {
        // Price is unknown — show em-dash, not $0.00
        usdStr = c.dim('—');
        grandTotalKnown = false;
      } else if (price !== undefined) {
        const n = typeof amount === 'string' ? parseFloat(amount) : amount;
        rawUsd  = isNaN(n) ? null : n * price;
        usdStr  = rawUsd !== null ? formatUsd(rawUsd) : c.dim('—');
      } else {
        usdStr = c.dim('—');
        grandTotalKnown = false;
      }

      // Show contract address (truncated) if present
      const assetLabel = contract
        ? `${symbol} ${c.dim(formatAddress(contract, opts))}`
        : symbol;

      // Watch-mode delta: append (+N) or (−N) to the amount if meaningful
      let amtDisplay = fmtAmt;
      if (deltas) {
        const deltaKey = `${chain}:${symbol.toUpperCase()}`;
        const delta = deltas.get(deltaKey);
        if (delta) {
          const prevN = parseFloat(delta.prev);
          const currN = parseFloat(delta.curr);
          if (!isNaN(prevN) && !isNaN(currN)) {
            const diff = currN - prevN;
            if (Math.abs(diff) > 0.0001) {
              const sign   = diff > 0 ? '+' : '−';
              const absDiff = Math.abs(diff);
              // Format delta with up to 6 significant decimal places
              const diffStr = absDiff.toLocaleString('en-US', {
                maximumFractionDigits: 6,
                minimumFractionDigits: 0,
              });
              const coloredDiff = diff > 0
                ? theme.movement.in(sign + diffStr)
                : theme.movement.out(sign + diffStr);
              amtDisplay = fmtAmt + ' ' + c.dim('(') + coloredDiff + c.dim(')');
            }
          }
        }
      }

      rows.push({ asset: assetLabel, amount: amtDisplay, usdValue: usdStr, rawUsd });
      if (rawUsd !== null) grandTotalUsd += rawUsd;
    };

    if (result.native) {
      addRow(result.native.symbol, result.native.amount, result.native.decimals ?? 18, null, false);
    }

    for (const token of result.tokens ?? []) {
      addRow(
        token.symbol,
        token.amount,
        token.decimals ?? 18,
        token.contract ?? null,
        token.noPrice === true,
      );
    }

    if (rows.length === 0) {
      console.log(c.dim('  (no assets)'));
      // Still render positions / NFT sections if available even when no assets
      if (opts.positions?.[chain]) {
        renderPositions(opts.positions[chain], opts);
      }
      if (opts.nfts?.[chain]) {
        renderNfts(opts.nfts[chain], opts);
      }
      continue;
    }

    // Task 10: decimal-aligned amount and USD columns
    renderTable(
      ['Asset', 'Amount', 'USD Value'],
      rows.map(r => [r.asset, r.amount, r.usdValue]),
      {
        rightAlign:   [false, true, true],
        decimalAlign: [1, 2],
      },
    );

    // DeFi positions section (Feature 5)
    if (opts.positions?.[chain]) {
      renderPositions(opts.positions[chain], opts);
    }

    // NFT holdings section
    if (opts.nfts?.[chain]) {
      renderNfts(opts.nfts[chain], opts);
    }
  }

  // Grand total
  console.log('');
  const totalStr = grandTotalKnown
    ? c.bold(c.green(formatUsd(grandTotalUsd)))
    : c.bold(c.yellow(formatUsd(grandTotalUsd) + '+'));
  console.log(c.bold('  Grand Total: ') + totalStr);
  if (!grandTotalKnown) {
    console.log(c.dim('  (+ indicates some asset prices are unavailable)'));
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// DeFi positions renderer (Feature 5)
// ---------------------------------------------------------------------------

/**
 * Render DeFi positions for a single chain.
 *
 * @param {{ aave?: any, uniswapV3?: any[] }} chainPositions
 * @param {{ verbose?: boolean }} [opts]
 */
export function renderPositions(chainPositions, opts = {}) {
  if (!chainPositions) return;

  const hasAave = chainPositions.aave?.hasPosition === true;
  const uniV3Positions = Array.isArray(chainPositions.uniswapV3)
    ? chainPositions.uniswapV3.filter(p => p != null)
    : [];

  if (!hasAave && uniV3Positions.length === 0) return;

  console.log('');
  console.log(`  ${theme.role.muted('DeFi Positions:')}`);

  if (hasAave) {
    const a = chainPositions.aave;
    const collateral = a.collateralUsd != null
      ? formatUsd(a.collateralUsd)
      : '—';
    const debt = a.debtUsd != null
      ? formatUsd(a.debtUsd)
      : '—';
    // healthFactor is pre-formatted by aave.js as a string ('2.34' or '∞').
    const hf = a.healthFactor != null ? String(a.healthFactor) : '∞';

    const label = padRight(theme.role.secondary('Aave V3'), 10);
    const vals =
      theme.role.primary(collateral) + theme.role.muted(' collateral') +
      theme.role.muted('  /  ') +
      theme.role.primary(debt) + theme.role.muted(' debt') +
      theme.role.muted('  /  HF: ') +
      theme.role.primary(hf);
    console.log(`    ${label}  ${vals}`);
  }

  if (uniV3Positions.length > 0) {
    const poolSummary = uniV3Positions
      .map(p => {
        const pair   = p.pair   ?? '???/???';
        const feeTier = p.feeTier != null ? `${p.feeTier}%` : null;
        return feeTier ? `${pair} ${feeTier}` : pair;
      })
      .join(', ');

    const label = padRight(theme.role.secondary('Uni V3'), 10);
    const count = theme.role.primary(String(uniV3Positions.length));
    const pools = theme.role.muted(`(${poolSummary})`);
    console.log(`    ${label}  ${count}${theme.role.muted(' positions')}  ${pools}`);
  }
}

// ---------------------------------------------------------------------------
// NFT holdings renderer
// ---------------------------------------------------------------------------

/**
 * Render NFT holdings for a single chain — collection name, count, floor,
 * total floor value. Deliberately text-only: no images, no ASCII art.
 *
 * @param {{
 *   collections: Array<{
 *     name: string, count: number,
 *     floorNative: number|null, floorUsd: number|null,
 *     totalNative: number|null, totalUsd: number|null,
 *   }>,
 *   totalCount: number,
 *   totalNative: number|null,
 *   totalUsd: number|null,
 *   nativeSymbol: string,
 *   error?: string|null,
 *   truncated?: boolean,
 * }} chainNfts
 * @param {{ verbose?: boolean }} [opts]
 */
export function renderNfts(chainNfts, opts = {}) {
  if (!chainNfts) return;
  if (chainNfts.error) {
    console.log('');
    console.log(`  ${theme.role.muted('NFTs:')} ${c.dim(chainNfts.error)}`);
    return;
  }

  const cols = chainNfts.collections ?? [];
  if (cols.length === 0) return;

  const sym = chainNfts.nativeSymbol || 'ETH';

  const fmtFloor = (native) =>
    native == null ? c.dim('—') : `${native.toFixed(4)} ${sym}`;

  const rows = cols.map(col => [
    col.name,
    String(col.count),
    fmtFloor(col.floorNative),
    col.totalUsd != null ? formatUsd(col.totalUsd) : c.dim('—'),
  ]);

  // Truncate long collection names so the table stays readable on narrow TTYs.
  const NAME_MAX = 28;
  for (const r of rows) {
    if (r[0].length > NAME_MAX) r[0] = r[0].slice(0, NAME_MAX - 1) + '…';
  }

  console.log('');
  const header = chainNfts.truncated
    ? `${theme.role.muted('NFTs:')} ${c.dim('(showing first 500 collections)')}`
    : theme.role.muted('NFTs:');
  console.log(`  ${header}`);

  renderTable(
    ['Collection', 'Count', 'Floor', 'Value'],
    rows,
    { rightAlign: [false, true, true, true], decimalAlign: [2, 3] },
  );

  // Aggregate line — only show if we have a meaningful total.
  if (chainNfts.totalUsd != null || chainNfts.totalNative != null) {
    const totalNative = chainNfts.totalNative != null
      ? `${chainNfts.totalNative.toFixed(4)} ${sym}`
      : '—';
    const totalUsd = chainNfts.totalUsd != null
      ? formatUsd(chainNfts.totalUsd)
      : '—';
    console.log(
      `  ${theme.role.muted('Total:')} ${theme.role.primary(totalNative)}  ` +
      `${theme.role.muted('≈')} ${theme.role.primary(totalUsd)}  ` +
      `${theme.role.muted(`(${chainNfts.totalCount} NFTs across ${cols.length} collections)`)}`
    );
  } else {
    console.log(
      `  ${theme.role.muted('Total:')} ${theme.role.primary(String(chainNfts.totalCount))} ` +
      `${theme.role.muted('NFTs across')} ${theme.role.primary(String(cols.length))} ${theme.role.muted('collections')} ` +
      `${c.dim('(some floors unavailable)')}`
    );
  }
}

// ---------------------------------------------------------------------------
// Multi-wallet helpers (Feature 4)
// ---------------------------------------------------------------------------

/**
 * Print a divider line with wallet identity.
 * ENS name + address (or address-only for raw wallets).
 *
 * @param {string|null} displayName  - ENS name or null
 * @param {string} address           - resolved EVM/BTC/SOL address
 * @param {{ verbose?: boolean }} [opts]
 */
export function renderWalletHeader(displayName, address, opts = {}) {
  const TOTAL_WIDTH = 60;
  const BAR = '━';
  const shortAddr = formatAddress(address, opts);

  const identity = displayName
    ? `${theme.role.accent(displayName)}  ${c.dim(`(${shortAddr})`)}`
    : theme.role.accent(shortAddr);

  // Visible length of the identity portion
  const identityPlain = displayName
    ? `${displayName}  (${shortAddr})`
    : shortAddr;

  const PREFIX_BARS = 5;
  const PADDING = 2; // spaces around the identity text
  const remaining = Math.max(
    0,
    TOTAL_WIDTH - PREFIX_BARS - PADDING * 2 - identityPlain.length
  );

  const leftBar  = c.dim(BAR.repeat(PREFIX_BARS));
  const rightBar = c.dim(BAR.repeat(remaining));

  console.log('');
  console.log(`  ${leftBar}  ${identity}  ${rightBar}`);
}

/**
 * Print a portfolio total line after all wallets in multi-wallet mode.
 *
 * @param {Array<{ results: Array<{ result: any, error: any }> }>} wallets
 * @param {Record<string, number>} prices
 */
export function renderPortfolioTotal(wallets, prices) {
  let total = 0;
  let totalKnown = true;
  const walletCount = wallets.length;

  for (const wallet of wallets) {
    for (const { result, error } of wallet.results) {
      if (error || !result || result.error) {
        totalKnown = false;
        continue;
      }

      const processAsset = (symbol, amount, noPrice) => {
        if (noPrice) { totalKnown = false; return; }
        const price = prices[symbol?.toUpperCase()];
        if (price === undefined) { totalKnown = false; return; }
        const n = typeof amount === 'string' ? parseFloat(amount) : amount;
        if (!isNaN(n)) total += n * price;
      };

      if (result.native) {
        processAsset(result.native.symbol, result.native.amount, false);
      }
      for (const token of result.tokens ?? []) {
        processAsset(token.symbol, token.amount, token.noPrice === true);
      }
    }
  }

  const DIVIDER_WIDTH = 55;
  const divider = c.dim('━'.repeat(DIVIDER_WIDTH));
  const label = c.bold(`PORTFOLIO TOTAL (${walletCount} wallet${walletCount !== 1 ? 's' : ''})`);
  const totalStr = totalKnown
    ? c.bold(c.green(formatUsd(total)))
    : c.bold(c.yellow(formatUsd(total) + '+'));

  console.log('');
  console.log(`  ${divider}`);

  // Pad label and total to fill the line
  const labelPlain = `PORTFOLIO TOTAL (${walletCount} wallet${walletCount !== 1 ? 's' : ''})`;
  const totalPlain = totalKnown
    ? formatUsd(total)
    : formatUsd(total) + '+';
  const gap = Math.max(1, DIVIDER_WIDTH - labelPlain.length - totalPlain.length);
  console.log(`  ${label}${' '.repeat(gap)}${totalStr}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Watch header (Feature 3)
// ---------------------------------------------------------------------------

/**
 * Print the watch-mode header banner.
 *
 * @param {string[]} addresses
 * @param {number} intervalSecs
 * @param {number|null} lastRefreshMs
 */
export function renderWatchHeader(addresses, intervalSecs, lastRefreshMs) {
  const label = theme.role.accent('WATCH MODE');
  const addrSummary = addresses.length === 1
    ? theme.role.accent(formatAddress(addresses[0]))
    : theme.role.accent(`${addresses.length} wallets`);

  const intervalStr = theme.role.muted(`refreshing every ${intervalSecs}s`);

  let lastStr = '';
  if (lastRefreshMs !== null) {
    const secs = (lastRefreshMs / 1000).toFixed(1);
    lastStr = theme.role.muted(`  last: ${secs}s`);
  }

  const stopStr = c.dim('  [Ctrl+C to stop]');

  console.log(`  ⛓ ${label}  ${addrSummary}  ${intervalStr}${lastStr}${stopStr}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Transaction rendering (Task 8)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   hash: string,
 *   chain: string,
 *   from: string,
 *   to: string,
 *   value: string,
 *   gasUsed: string|number,
 *   gasPriceGwei: string|number,
 *   gasCostUsd: string,
 *   status: 'success' | 'failed' | 'pending',
 *   summary: string,
 *   raw: object
 * }} TxResult
 */

/**
 * Look up a known contract name by address from the decoder registry.
 * Returns null if unknown.
 *
 * @param {string} addr
 * @returns {string|null}
 */
function contractName(addr) {
  if (!addr) return null;
  return KNOWN_CONTRACTS[addr.toLowerCase()] ?? null;
}

/**
 * Render the prominent headline block for a transaction.
 *
 * @param {TxResult} tx
 * @param {{ verbose?: boolean }} [opts]
 */
export function renderTxHeadline(tx, opts = {}) {
  const statusIcon =
    tx.status === 'success' ? theme.status.ok('✓') :
    tx.status === 'failed'  ? theme.status.fail('✗') :
    theme.status.pending('⏳');

  // Build the summary line — replace "for" separator with "→" for swaps
  let summaryText = tx.summary ?? '';
  summaryText = summaryText.replace(/ for (?=[0-9])/g, ' → ');

  // If no decoded summary, fall back to a generic description
  if (!summaryText) {
    const to = tx.to ? formatAddress(tx.to, opts) : 'unknown';
    summaryText = tx.value && tx.value !== '0 ETH' && tx.value !== '0 POL'
      ? `Transfer ${tx.value}`
      : `Called on ${to}`;
  }

  // Extract "via Protocol" from summary for the sub-line if present
  const viaMatch = summaryText.match(/ via (.+)$/);
  const headline   = viaMatch ? summaryText.slice(0, viaMatch.index) : summaryText;
  const viaStr     = viaMatch ? viaMatch[1] : null;

  const badge = chainBadge(tx.chain ?? 'ethereum');

  console.log('');
  console.log(`  ${statusIcon}  ${theme.role.primary(headline)}`);
  if (viaStr) {
    console.log(`     ${theme.role.muted(`via ${viaStr} on`)} ${badge}`);
  } else {
    console.log(`     ${theme.role.muted('on')} ${badge}`);
  }
}

/**
 * Render the labeled fields block for a transaction.
 *
 * @param {TxResult} tx
 * @param {{ verbose?: boolean }} [opts]
 */
export function renderTxMeta(tx, opts = {}) {
  const divider = c.dim('  ' + '─'.repeat(43));
  console.log(divider);

  const gasUsed   = tx.gasUsed   != null ? Number(tx.gasUsed).toLocaleString('en-US') : '—';
  const gwei      = tx.gasPriceGwei != null ? `${tx.gasPriceGwei} gwei` : null;
  const gasCostUsd = tx.gasCostUsd && tx.gasCostUsd !== 'N/A' ? tx.gasCostUsd : null;

  const gasLine   = [gasUsed, gwei, gasCostUsd].filter(Boolean).join(' × ').replace(/ × ([^×]+)$/, (_, last) => ` · ${last}`);

  const shortHash = tx.hash
    ? (opts.verbose ? tx.hash : `${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}`)
    : '(unknown)';

  const fromAddr  = formatAddress(tx.from ?? '—', opts);
  const toAddr    = formatAddress(tx.to   ?? '—', opts);
  const fromLabel = tx.fromName ?? contractName(tx.from);
  const toLabel   = tx.toName   ?? contractName(tx.to);

  const labelW = 7;
  const field = (label, value) => {
    const lbl = theme.role.muted(label.padEnd(labelW));
    console.log(`  ${lbl}  ${theme.role.secondary(value)}`);
  };

  field('Hash',  shortHash + (opts.verbose ? '' : '  ↗'));
  field('From',  fromAddr  + (fromLabel ? `  ${c.dim(`(${fromLabel})`)}` : ''));
  field('To',    toAddr    + (toLabel   ? `  ${c.dim(`(${toLabel})`)}`   : ''));
  if (tx.value && tx.value !== '0 ETH' && tx.value !== '0 POL') {
    field('Value', tx.value);
  }
  if (gasLine) field('Gas', gasLine);

  console.log(divider);
  console.log('');
}

// ---------------------------------------------------------------------------
// Token movement helpers
// ---------------------------------------------------------------------------

/**
 * Split a decimal string into integer and fractional parts.
 * Returns { intPart, fracPart } as plain strings (no dot).
 * For non-numeric values (e.g. 'Unlimited', '#123') returns the raw string as
 * intPart with an empty fracPart so the caller can detect and left-align them.
 *
 * @param {string} amount
 * @returns {{ intPart: string, fracPart: string, isSpecial: boolean }}
 */
function splitDecimal(amount) {
  const s = String(amount ?? '');
  // Treat NFT amounts (#…) and Unlimited as opaque left-aligned strings
  if (s.startsWith('#') || s === 'Unlimited') {
    return { intPart: s, fracPart: '', isSpecial: true };
  }
  const dot = s.indexOf('.');
  if (dot === -1) return { intPart: s, fracPart: '', isSpecial: false };
  return { intPart: s.slice(0, dot), fracPart: s.slice(dot + 1), isSpecial: false };
}

/**
 * Compute the decimal-alignment widths across an array of amount strings.
 *
 * @param {string[]} amounts
 * @returns {{ maxInt: number, maxFrac: number, anyFrac: boolean }}
 */
function decimalWidths(amounts) {
  let maxInt = 0;
  let maxFrac = 0;
  let anyFrac = false;
  for (const a of amounts) {
    const { intPart, fracPart, isSpecial } = splitDecimal(a);
    if (isSpecial) {
      maxInt = Math.max(maxInt, intPart.length);
    } else {
      maxInt  = Math.max(maxInt,  intPart.length);
      maxFrac = Math.max(maxFrac, fracPart.length);
      if (fracPart.length > 0) anyFrac = true;
    }
  }
  return { maxInt, maxFrac, anyFrac };
}

/**
 * Format a single amount string so it decimal-aligns within the given widths.
 *
 * @param {string} amount
 * @param {{ maxInt: number, maxFrac: number, anyFrac: boolean }} widths
 * @returns {string}  plain string (no ANSI), ready for further styling
 */
function formatAlignedAmount(amount, { maxInt, maxFrac, anyFrac }) {
  const { intPart, fracPart, isSpecial } = splitDecimal(amount);
  if (isSpecial) {
    // Left-align, total width = maxInt + (anyFrac ? 1 + maxFrac : 0)
    const totalW = maxInt + (anyFrac ? 1 + maxFrac : 0);
    return intPart.padEnd(totalW);
  }
  const paddedInt  = intPart.padStart(maxInt);
  if (!anyFrac) return paddedInt;
  const paddedFrac = fracPart.padEnd(maxFrac);
  return `${paddedInt}.${paddedFrac}`;
}

/**
 * Render the approvals sub-block.  Called from renderTxMovements.
 *
 * @param {object[]} approvals  - decoded approval objects
 * @param {{ verbose?: boolean }} opts
 */
export function renderTxApprovals(approvals, opts = {}) {
  if (!Array.isArray(approvals) || approvals.length === 0) return;

  console.log('');
  console.log(`    ${theme.role.muted('Approvals:')}`);

  for (const appr of approvals) {
    const spenderLabel = appr.spenderName ?? formatAddress(appr.spender ?? '', opts);
    const symbol       = appr.symbol ?? '???';
    const amount       = appr.amount ?? '—';

    // "→ Approved <amount> <SYMBOL> for <spender>"
    const glyph   = theme.movement.approve('→');
    const content = theme.role.secondary(`Approved ${amount} `) +
                    theme.role.primary(symbol) +
                    theme.role.secondary(` for ${spenderLabel}`);
    console.log(`      ${glyph} ${content}`);
  }
}

/**
 * Render the token movements block (and approvals sub-block) between
 * the headline and the meta divider.
 *
 * Skipped entirely when both `tokenMovements` and `approvals` are empty /
 * absent.
 *
 * @param {TxResult & {
 *   tokenMovements?: Array<{
 *     direction: 'in'|'out',
 *     amount: string,
 *     symbol: string,
 *     counterparty: string,
 *     counterpartyName: string|null,
 *     token: string,
 *     rawAmount: string,
 *   }>,
 *   approvals?: Array<{
 *     spender: string,
 *     spenderName: string|null,
 *     symbol: string,
 *     amount: string,
 *     token: string,
 *   }>
 * }} tx
 * @param {{ verbose?: boolean }} [opts]
 */
export function renderTxMovements(tx, opts = {}) {
  const movements = Array.isArray(tx.tokenMovements) ? tx.tokenMovements : [];
  const approvals = Array.isArray(tx.approvals)      ? tx.approvals      : [];

  if (movements.length === 0 && approvals.length === 0) return;

  // ── Blank line after headline ──────────────────────────────────────────────
  console.log('');

  if (movements.length > 0) {
    console.log(`  ${theme.role.muted('Token movements:')}`);

    // Pre-compute decimal-alignment widths for amounts across this tx
    const amounts = movements.map(m => m.amount ?? '—');
    const dw = decimalWidths(amounts);

    // Pre-compute the max rendered width of "sign amount symbol" to align
    // the counterparty column.
    // sign = 1 char + 1 space, amount is decimal-aligned, then 1 space + symbol
    const symbolWidths = movements.map(m => (m.symbol ?? '???').length);
    const maxSymbolW   = Math.max(...symbolWidths);
    // total amount column = maxInt + (anyFrac ? 1 + maxFrac : 0)
    const amtColW = dw.maxInt + (dw.anyFrac ? 1 + dw.maxFrac : 0);
    // sign (1) + space (1) + amtCol + space (1) + symbol left-padded to maxSymbolW
    // We'll pad each symbol to maxSymbolW for consistent column start
    // Full left column width: 1 + 1 + amtColW + 1 + maxSymbolW = amtColW + maxSymbolW + 3
    const leftColW = 1 + 1 + amtColW + 1 + maxSymbolW;

    // The tx initiator (from). Movements where the user sent tokens are 'out',
    // received are 'in' — relative to tx.from. Label that side with the sender's
    // ENS name / known contract name / truncated address rather than "you",
    // since we may be inspecting someone else's transaction.
    const senderRaw   = tx.from ?? '';
    const senderTrunc = senderRaw ? formatAddress(senderRaw, opts) : '—';
    const senderLabel = !opts.verbose && (tx.fromName || contractName(senderRaw))
      ? (tx.fromName ?? contractName(senderRaw))
      : senderTrunc;

    for (const mv of movements) {
      const dir = mv.direction === 'in' ? 'in' : 'out';

      // Sign
      const signGlyph = dir === 'out' ? '−' : '+';
      const signStyled = dir === 'out'
        ? theme.movement.out(signGlyph)
        : theme.movement.in(signGlyph);

      // Amount (decimal-aligned, plain) then styled
      const alignedAmt = formatAlignedAmount(mv.amount ?? '—', dw);
      const amtStyled  = theme.role.secondary(alignedAmt);

      // Symbol (padded to maxSymbolW, bold primary)
      const symbol        = (mv.symbol ?? '???').padEnd(maxSymbolW);
      const symbolStyled  = theme.role.primary(symbol);

      // Counterparty display
      const rawAddr     = mv.counterparty ?? '';
      const truncAddr   = formatAddress(rawAddr, opts);
      // Prefer name if non-null and non-empty, unless verbose mode (show raw)
      const otherLabel  = (!opts.verbose && mv.counterpartyName)
        ? mv.counterpartyName
        : truncAddr;

      const senderStyled = theme.role.accent(senderLabel);
      const otherStyled  = theme.role.muted(otherLabel);
      const arrowStyled  = theme.role.muted(' → ');

      const cpPart = dir === 'out'
        ? senderStyled + arrowStyled + otherStyled
        : otherStyled  + arrowStyled + senderStyled;

      // Assemble the line, padding the left column to leftColW visible chars
      // so counterparty column starts at a consistent offset.
      // Left column (unstyled measure): sign(1) + space(1) + alignedAmt + space(1) + symbol(maxSymbolW)
      const leftUnstyled = signGlyph + ' ' + alignedAmt + ' ' + (mv.symbol ?? '???').padEnd(maxSymbolW);
      const leftPad = leftColW - leftUnstyled.length; // should be 0 since we computed exactly

      const leftStyled = signStyled + ' ' + amtStyled + ' ' + symbolStyled +
        (leftPad > 0 ? ' '.repeat(leftPad) : '');

      console.log(`    ${leftStyled}   ${cpPart}`);
    }
  }

  // ── Approvals sub-block ────────────────────────────────────────────────────
  if (approvals.length > 0) {
    renderTxApprovals(approvals, opts);
  }

  // ── Trailing blank line before meta divider ────────────────────────────────
  console.log('');
}

/**
 * Render a decoded transaction summary block to stdout.
 *
 * @param {TxResult} tx
 * @param {{ verbose?: boolean }} [opts]
 */
export function renderTransaction(tx, opts = {}) {
  renderTxHeadline(tx, opts);
  renderTxMovements(tx, opts);
  renderTxMeta(tx, opts);
}

// ---------------------------------------------------------------------------
// Gas command rendering
// ---------------------------------------------------------------------------

/** 8-level unicode block characters for sparkline rendering, low → high. */
const SPARK_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Render a sparkline from an array of numbers using unicode block chars.
 * Min/max normalized; flat input renders as the middle block.
 *
 * @param {number[]} values
 * @returns {string}
 */
export function sparkline(values) {
  if (!Array.isArray(values) || values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return SPARK_BLOCKS[3].repeat(values.length);
  return values
    .map(v => {
      const idx = Math.round(((v - min) / range) * (SPARK_BLOCKS.length - 1));
      return SPARK_BLOCKS[Math.max(0, Math.min(SPARK_BLOCKS.length - 1, idx))];
    })
    .join('');
}

/** Compact short label per chain for the gas table (saves horizontal space). */
const GAS_CHAIN_LABEL = {
  ethereum: { glyph: '⬢', short: 'ETH'   },
  polygon:  { glyph: '⬡', short: 'POL'   },
  arbitrum: { glyph: '◆', short: 'ARB'   },
  base:     { glyph: '▲', short: 'BASE'  },
  optimism: { glyph: '◉', short: 'OP'    },
  zksync:   { glyph: '⟁', short: 'ZK'    },
  linea:    { glyph: '⬣', short: 'LINEA' },
  bitcoin:  { glyph: '₿', short: 'BTC'   },
  solana:   { glyph: '◎', short: 'SOL'   },
};

/**
 * Format a gwei value with adaptive precision.
 * Sub-milligwei values are reported as "<0.001" — common on OP-stack L2s
 * where base fees are sub-nano-gwei (a few hundred wei).
 *
 * @param {number|null} gwei
 * @returns {string}
 */
function fmtGwei(gwei) {
  if (gwei == null) return '—';
  if (gwei === 0)   return '0';
  if (gwei >= 100)   return gwei.toFixed(1);
  if (gwei >= 10)    return gwei.toFixed(2);
  if (gwei >= 1)     return gwei.toFixed(3);
  if (gwei >= 0.001) return gwei.toFixed(4);
  return '<0.001';
}

/**
 * USD cost of a transaction at totalGwei × gasUnits, given the native price.
 * Returns null if native price is unknown.
 *
 * @param {number} totalGwei
 * @param {number} gasUnits
 * @param {number|null} nativePriceUsd
 * @returns {number|null}
 */
function costUsd(totalGwei, gasUnits, nativePriceUsd) {
  if (totalGwei == null || nativePriceUsd == null || nativePriceUsd <= 0) return null;
  const ethCost = totalGwei * gasUnits * 1e-9;
  return ethCost * nativePriceUsd;
}

/**
 * Format a USD cost with adaptive precision so very small (sub-cent) costs
 * remain meaningful instead of collapsing to "$0.00".
 *
 * @param {number|null} usd
 * @returns {string}
 */
function fmtUsdCost(usd) {
  if (usd == null) return c.dim('—');
  if (usd >= 1)     return '$' + usd.toFixed(2);
  if (usd >= 0.01)  return '$' + usd.toFixed(3);
  if (usd >= 0.0001) return '$' + usd.toFixed(4);
  return '<$0.0001';
}

/**
 * Color a sparkline based on its trend (last vs. first sample).
 * Up = red (more expensive), down = green, flat = dim.
 *
 * @param {string} bar
 * @param {number[]} values
 * @returns {string}
 */
function colorSparkline(bar, values) {
  if (values.length < 2) return c.dim(bar);
  const first = values[0];
  const last  = values[values.length - 1];
  if (first === 0) return c.dim(bar);
  const pctChange = (last - first) / first;
  if (Math.abs(pctChange) < 0.05) return c.dim(bar);
  return pctChange > 0 ? c.red(bar) : c.green(bar);
}

/**
 * Render a Bitcoin fee section.
 *
 * @param {import('../gas.js').GasResult} r
 * @param {Record<string, number>} prices
 */
function renderBitcoinSection(r, prices) {
  const label = GAS_CHAIN_LABEL.bitcoin;
  const btcPrice = prices?.BTC ?? null;
  const f = r.bitcoin?.fees;
  if (!f) return;

  console.log('');
  console.log('  ' + theme.role.accent(label.glyph) + ' ' + c.bold(label.short)
    + '  ' + c.dim('— recommended fees (sat/vB)'));

  const sizes = { p2wpkh: 141, p2sh: 250 };
  const tiers = [
    { name: 'Next block',  v: f.fastest  },
    { name: '30 min',      v: f.halfHour },
    { name: '1 hour',      v: f.hour     },
    { name: 'Economy',     v: f.economy  },
    { name: 'Minimum',     v: f.minimum  },
  ].filter(t => t.v != null);

  const headers = ['Tier', 'sat/vB', `Send (${sizes.p2wpkh}vB)`, `Multi-in (${sizes.p2sh}vB)`];
  const rows = tiers.map(t => {
    const usdSmall = btcPrice != null ? (t.v * sizes.p2wpkh * 1e-8 * btcPrice) : null;
    const usdLarge = btcPrice != null ? (t.v * sizes.p2sh   * 1e-8 * btcPrice) : null;
    return [
      t.name,
      String(t.v),
      fmtUsdCost(usdSmall),
      fmtUsdCost(usdLarge),
    ];
  });

  renderTable(headers, rows, {
    rightAlign: [false, true, true, true],
  });

  if (r.bitcoin.mempool) {
    const m = r.bitcoin.mempool;
    const countStr = m.count.toLocaleString('en-US');
    const sizeStr  = m.vsizeMB.toFixed(1) + ' MB';
    console.log('  ' + c.dim(`Mempool: ${countStr} pending  ·  ${sizeStr}`));
  }
}

/**
 * Render a Solana priority-fee section.
 *
 * @param {import('../gas.js').GasResult} r
 * @param {Record<string, number>} prices
 */
function renderSolanaSection(r, prices) {
  const label = GAS_CHAIN_LABEL.solana;
  const solPrice = prices?.SOL ?? null;
  const s = r.solana;
  if (!s) return;

  const congestionColor =
    s.congestion === 'congested' ? c.red :
    s.congestion === 'low'       ? c.green :
    c.yellow;

  console.log('');
  console.log('  ' + theme.role.accent(label.glyph) + ' ' + c.bold(label.short)
    + '  ' + c.dim('— priority fees (μlamports/CU)'));

  // Cost helper: (μL/CU × CU) / 1e6 → lamports; +5000 base; / 1e9 → SOL × price.
  const txCostUsd = (cu) => {
    if (solPrice == null || solPrice <= 0) return null;
    const lamports = (s.priorityMicroLamports.med * cu) / 1_000_000 + s.baseLamports;
    const sol = lamports / 1e9;
    return sol * solPrice;
  };

  const txTypes = [
    { name: 'Transfer (200 CU)',     usd: txCostUsd(200)     },
    { name: 'SPL transfer (5k CU)',  usd: txCostUsd(5_000)   },
    { name: 'Swap (150k CU)',        usd: txCostUsd(150_000) },
  ];

  const headers = ['Tx type', 'Cost'];
  const rows = txTypes.map(t => [t.name, fmtUsdCost(t.usd)]);
  renderTable(headers, rows, { rightAlign: [false, true] });

  console.log('');
  const tiers =
    c.green(s.priorityMicroLamports.low.toLocaleString('en-US'))  + c.dim(' / ') +
    c.yellow(s.priorityMicroLamports.med.toLocaleString('en-US')) + c.dim(' / ') +
    c.red(s.priorityMicroLamports.high.toLocaleString('en-US'));
  console.log('  ' + c.dim('Priority tiers (μL/CU) low / med / high:  ') + tiers);

  const tpsStr = s.tps != null ? `${s.tps.toLocaleString('en-US')} TPS` : 'TPS unknown';
  console.log('  ' + c.dim(`Network: ${tpsStr}  · `) + congestionColor(`[${s.congestion}]`));
  console.log('  ' + c.dim('Base fee: 5,000 lamports/sig (fixed)'));
}

/**
 * Render the gas command output (pretty mode only — JSON is handled upstream
 * via src/output/envelope.js + buildGasData).
 *
 * @param {import('../gas.js').GasResult[]} results
 * @param {Record<string, number>} prices  - { ETH, POL, BTC, SOL, ... }
 * @param {{ verbose?: boolean }} [opts]
 */
export function renderGas(results, prices, opts = {}) {
  const evmResults = results.filter(r => r.family === 'evm');
  const btcResult  = results.find(r => r.family === 'bitcoin');
  const solResult  = results.find(r => r.family === 'solana');

  console.log('');
  console.log('  ' + c.bold('GAS PRICES') + '  ' + c.dim('— recent trend (last 64 blocks)'));

  // ── EVM table ──────────────────────────────────────────────────────────────
  if (evmResults.length > 0) {
    console.log('');
    const headers = ['Chain', 'Base', 'Priority', 'Next', '+5 blk', '+20 blk', 'Trend', 'Send (21k)'];
    const rows = [];

    for (const r of evmResults) {
      const labelInfo = GAS_CHAIN_LABEL[r.chain] ?? { glyph: '●', short: r.chain.slice(0, 4).toUpperCase() };
      const chainCell = theme.role.accent(labelInfo.glyph) + ' ' + c.bold(labelInfo.short);

      if (r.error) {
        rows.push([chainCell, c.red('error'), '', '', '', '', '', '']);
        continue;
      }

      const nativePrice = prices?.[r.nativeSymbol] ?? null;

      const baseStr  = fmtGwei(r.baseFeeGwei);
      const prioStr  = r.priorityGwei ? fmtGwei(r.priorityGwei.med)        : '—';
      const nextStr  = r.nextBlock    ? fmtGwei(r.nextBlock.totalGwei)     : '—';
      const blk5Str  = r.blocks5      ? fmtGwei(r.blocks5.totalGwei)       : c.dim('—');
      const blk20Str = r.blocks20     ? fmtGwei(r.blocks20.totalGwei)      : c.dim('—');

      const sparkBar  = sparkline(r.sparkline);
      const sparkCell = sparkBar.length > 0
        ? colorSparkline(sparkBar, r.sparkline)
        : c.dim('—');

      const sendUsd  = r.nextBlock
        ? costUsd(r.nextBlock.totalGwei, 21_000, nativePrice)
        : null;
      const sendCell = fmtUsdCost(sendUsd);

      rows.push([chainCell, baseStr, prioStr, nextStr, blk5Str, blk20Str, sparkCell, sendCell]);
    }

    renderTable(headers, rows, {
      rightAlign: [false, true, true, true, true, true, false, true],
    });

    // Priority tiers footer (EVM only — units are gwei).
    console.log('');
    console.log('  ' + c.dim('Priority fee tiers (gwei) — low / med / high:'));
    for (const r of evmResults) {
      if (r.error || !r.priorityGwei) continue;
      const labelInfo = GAS_CHAIN_LABEL[r.chain] ?? { glyph: '●', short: r.chain.toUpperCase() };
      const tag = '    ' + theme.role.accent(labelInfo.glyph) + ' ' + c.bold(labelInfo.short.padEnd(5));
      const tiers =
        c.green(fmtGwei(r.priorityGwei.low))  + c.dim(' / ') +
        c.yellow(fmtGwei(r.priorityGwei.med)) + c.dim(' / ') +
        c.red(fmtGwei(r.priorityGwei.high));
      console.log(`${tag}  ${tiers}`);
    }
  }

  // ── Bitcoin section ────────────────────────────────────────────────────────
  if (btcResult) {
    if (btcResult.error) {
      console.log('');
      console.log('  ' + theme.role.accent(GAS_CHAIN_LABEL.bitcoin.glyph) + ' '
        + c.bold(GAS_CHAIN_LABEL.bitcoin.short) + '  ' + c.red('error: ' + btcResult.error));
    } else {
      renderBitcoinSection(btcResult, prices);
    }
  }

  // ── Solana section ─────────────────────────────────────────────────────────
  if (solResult) {
    if (solResult.error) {
      console.log('');
      console.log('  ' + theme.role.accent(GAS_CHAIN_LABEL.solana.glyph) + ' '
        + c.bold(GAS_CHAIN_LABEL.solana.short) + '  ' + c.red('error: ' + solResult.error));
    } else {
      renderSolanaSection(solResult, prices);
    }
  }

  // ── L2 caveat (EVM L2s only) ───────────────────────────────────────────────
  const hasL2 = evmResults.some(r => r.isL2 && !r.error);
  if (hasL2) {
    console.log('');
    console.log('  ' + c.dim('L2 chains show execution fee only; small L1 data fee adds extra per tx.'));
  }

  // ── Degraded / RPC fallback note ───────────────────────────────────────────
  const degraded = results.filter(r => r.degraded);
  if (degraded.length > 0) {
    console.log('  ' + c.dim(`(degraded data on ${degraded.map(d => d.chain).join(', ')} — primary source unavailable)`));
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------

/**
 * Print help text to stdout.
 *
 * @param {string} version
 */
export function renderHelp(version) {
  console.log(`
${c.bold('glnc')} ${c.dim(`v${version}`)} — blockchain inspection CLI

${c.bold('USAGE')}  glnc <command> [args] [flags]

  balance <address>...     wallet balances across detected chains
  tx <hash>                decode a transaction
  gas                      current gas across EVM + BTC + SOL
  history <address>        export transaction history (CSV / JSON)
  alert <address>          watch a condition; POST to webhook on trigger
  interactive              guided TUI for building a command
  schema                   print JSON output schemas

${c.bold('COMMON FLAGS')}
  --chain <name>  --watch  --json  --verbose  --no-color

${c.bold('MORE')}  glnc <command> --help   ·   full docs: README.md
`);
}

const HELP_BALANCE = `
${c.bold('glnc balance')} <address>... [flags]

  Query wallet balances across all detected chains in parallel. Auto-detects
  the chain from the address format; pass --chain to scope to one chain.

${c.bold('FLAGS')}
  --chain <name>      single chain (eth/poly/arb/base/sol/btc)
  --watch / -w        re-poll on an interval; show deltas in place
  --interval <N>      seconds between polls (default 15)
  --positions / -p    include DeFi positions (Aave V3, Uniswap V3 LP)
  --nfts / -n         include NFT holdings (Reservoir API, EVM only)
  --verbose / -v      show full addresses
  --json              emit JSON envelope on stdout (NDJSON when --watch)
  --ndjson            force NDJSON even for one-shot
  --strict            in --watch --json, exit non-zero on fetch error
  --no-color          disable ANSI colors

${c.bold('EXAMPLES')}
  glnc balance vitalik.eth
  glnc balance 0xd8dA…6045 0xABC…123 bc1q…wlh
  glnc balance 0x… --watch --interval 30
  glnc balance 0x… --json | jq .data.wallets[0].grandTotalUsd
`;

const HELP_TX = `
${c.bold('glnc tx')} <hash> [flags]

  Decode a transaction. EVM hashes (0x + 64 hex) decode calldata + receipt
  log token movements. Solana signatures (base58 ~88 chars) return slot,
  fee, status, and accounts.

${c.bold('FLAGS')}
  --chain <name>      override chain (default: ethereum, or solana for base58)
  --json              emit JSON envelope on stdout
  --verbose / -v      show full addresses
  --no-color          disable ANSI colors

${c.bold('EXAMPLES')}
  glnc tx 0x02d15281c5514a447192cc8d6140216050f8d3bf92efccd420b635274764fb94
  glnc tx <sig> --chain solana --json
`;

const HELP_GAS = `
${c.bold('glnc gas')} [flags]

  Current gas across EVM chains + Bitcoin + Solana. EVM tiers come from
  eth_feeHistory (p10/50/90 priority percentiles). BTC uses mempool.space.
  Sol uses getRecentPrioritizationFees.

${c.bold('FLAGS')}
  --chain <name>      single chain (eth/poly/arb/base/op/zk/linea/btc/sol)
  --watch / -w        live tracker (alt-screen, scrollback preserved)
  --interval <N>      seconds between polls (default 15)
  --json              emit JSON / NDJSON
  --verbose / -v      extra columns
  --no-color          disable ANSI colors

${c.bold('EXAMPLES')}
  glnc gas
  glnc gas --chain eth --watch --interval 10
  glnc gas --json | jq '.data.chains[] | {chain, baseFeeGwei}'
`;

const HELP_HISTORY = `
${c.bold('glnc history')} <address> [flags]

  Pull transaction history → CSV (tax export) or JSON. Uses Etherscan V2
  unified API for EVM chains; pass --api-key or set GLNC_ETHERSCAN_KEY for
  higher rate limits.

${c.bold('FLAGS')}
  --chain <name>      single EVM chain (default: all detected)
  --from <YYYY-MM-DD> start date (inclusive)
  --to <YYYY-MM-DD>   end date (inclusive)
  --out <path>        write CSV to file (--out auto for ./glnc-<addr>.csv)
  --json              emit JSON instead of CSV
  --no-prices         skip historical USD lookup (faster)
  --api-key <key>     Etherscan V2 key

${c.bold('EXAMPLES')}
  glnc history 0xd8dA…6045 --out auto
  glnc history 0x… --from 2025-01-01 --to 2025-12-31 --chain arbitrum --json
`;

const HELP_BY_COMMAND = {
  balance: HELP_BALANCE,
  tx:      HELP_TX,
  gas:     HELP_GAS,
  history: HELP_HISTORY,
};

/**
 * Print per-command help. Returns true if the command had a dedicated help
 * page; false if the caller should fall through to the global `renderHelp`.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function renderCommandHelp(command) {
  const text = HELP_BY_COMMAND[command];
  if (!text) return false;
  console.log(text);
  return true;
}

/**
 * Print version to stdout.
 *
 * @param {string} version
 */
export function renderVersion(version) {
  console.log(`glnc v${version}`);
}

/**
 * Print an error message to stderr.
 *
 * @param {string} message
 */
export function renderError(message) {
  process.stderr.write(`${c.red('Error:')} ${message}\n`);
}

// Re-export c and theme so callers that currently do `import { c } from './render.js'` keep working
export { c, theme, chainBadge };
