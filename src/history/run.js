/**
 * src/history/run.js
 *
 * Orchestrator for the `glnc history` command.
 *
 * Pulls a wallet's transaction history for a date range from Etherscan V2,
 * classifies each transaction, enriches with historical USD prices from
 * CoinGecko, and emits a CSV that's ready to hand to a tax preparer.
 *
 * Pretty mode → CSV to stdout (or a file via --out) + a one-line summary on
 * stderr. JSON mode → single envelope with the structured rows.
 */

import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { wrap, wrapError } from '../output/envelope.js';
import { emitJSON, emitNDJSON } from '../output/emit.js';
import { SCHEMA } from '../output/schemas.js';
import { renderError, c, theme } from '../cli/render.js';

const SUPPORTED_CHAINS = ['ethereum', 'polygon', 'arbitrum', 'base', 'optimism'];
const DEFAULT_LOOKBACK_DAYS = 365;

/**
 * Parse a 'YYYY-MM-DD' string into a unix-second timestamp at UTC midnight.
 * Returns null on bad input.
 *
 * @param {string} s
 * @param {boolean} endOfDay  true = 23:59:59 UTC, false = 00:00:00 UTC
 * @returns {number|null}
 */
function parseDate(s, endOfDay = false) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const d = parseInt(m[3], 10);
  const ms = endOfDay
    ? Date.UTC(y, mo, d, 23, 59, 59)
    : Date.UTC(y, mo, d, 0, 0, 0);
  if (isNaN(ms)) return null;
  // Reject rollovers like 2025-02-31 → March 3 by round-tripping the components.
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo || back.getUTCDate() !== d) return null;
  return Math.floor(ms / 1000);
}

/**
 * EVM address validator.
 *
 * @param {string} addr
 * @returns {boolean}
 */
function isEvmAddress(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/**
 * Default output filename for a pretty-mode --out=auto export. Avoids
 * overwriting by including chain and a short hash prefix.
 *
 * @param {string} address
 * @param {string} chain
 * @returns {string}
 */
function defaultCsvName(address, chain) {
  const stamp = new Date().toISOString().slice(0, 10);
  const short = address.slice(2, 8).toLowerCase();
  return `glnc-history-${chain}-${short}-${stamp}.csv`;
}

/**
 * Run the history command.
 *
 * @param {string} addressInput
 * @param {{
 *   chain?: string,
 *   from?: string,
 *   to?: string,
 *   out?: string,
 *   apiKey?: string,
 *   noPrices?: boolean,
 *   json?: boolean,
 *   verbose?: boolean,
 * }} [opts]
 */
export async function runHistory(addressInput, opts = {}) {
  const json = !!opts.json;
  const ndjson = !!opts.ndjson;
  const emit = ndjson ? emitNDJSON : emitJSON;
  const noPrices = !!opts.noPrices;

  const emitErr = (msg, exitCode, code = 'error') => {
    if (json) emit(wrapError(SCHEMA.HISTORY, msg, { code }));
    else renderError(msg);
    process.exitCode = exitCode;
  };

  // ── Validate inputs ───────────────────────────────────────────────────────
  if (!addressInput || !isEvmAddress(addressInput)) {
    emitErr(
      'glnc history requires a valid EVM address (0x + 40 hex chars). ' +
      'v1 supports EVM chains only.',
      1, 'bad-address',
    );
    return;
  }
  const address = addressInput.toLowerCase();

  const chain = opts.chain ?? 'ethereum';
  if (!SUPPORTED_CHAINS.includes(chain)) {
    emitErr(
      `Unsupported chain "${chain}". history supports: ${SUPPORTED_CHAINS.join(', ')}.`,
      1, 'unsupported-chain',
    );
    return;
  }

  // Resolve date range. Default: last 365 days ending today.
  const nowSec = Math.floor(Date.now() / 1000);
  const toTs = opts.to ? parseDate(opts.to, true) : nowSec;
  if (toTs === null) {
    emitErr(`--to date must be YYYY-MM-DD; got "${opts.to}"`, 1, 'bad-date');
    return;
  }
  const fromTs = opts.from
    ? parseDate(opts.from, false)
    : (toTs - DEFAULT_LOOKBACK_DAYS * 86400);
  if (fromTs === null) {
    emitErr(`--from date must be YYYY-MM-DD; got "${opts.from}"`, 1, 'bad-date');
    return;
  }
  if (fromTs >= toTs) {
    emitErr('--from must be earlier than --to', 1, 'bad-range');
    return;
  }

  // ── Lazy-load history modules ─────────────────────────────────────────────
  // These are written by a parallel agent — the imports happen at call time
  // so a missing module surfaces as a clean error here, not at process start.
  let etherscan, classifier, prices, csv, costBasisMod;
  try {
    [etherscan, classifier, prices, csv, costBasisMod] = await Promise.all([
      import('./etherscan.js'),
      import('./classifier.js'),
      import('./prices_history.js'),
      import('./csv.js'),
      import('./cost_basis.js'),
    ]);
  } catch (err) {
    emitErr(
      `history modules are not available: ${err?.message ?? err}. ` +
      'Try reinstalling glnc.',
      2, 'missing-module',
    );
    return;
  }

  const apiKey = opts.apiKey ?? process.env.GLNC_ETHERSCAN_KEY ?? null;
  const warnings = [];
  const onWarn = msg => warnings.push(String(msg));

  // ── Resolve block range ───────────────────────────────────────────────────
  if (!json) {
    process.stderr.write(
      c.dim(`  resolving block range on ${theme.brand(chain)} `) +
      c.dim(`(${new Date(fromTs * 1000).toISOString().slice(0, 10)} → `) +
      c.dim(`${new Date(toTs * 1000).toISOString().slice(0, 10)})\n`)
    );
  }

  const range = await etherscan.resolveBlockRange(chain, fromTs, toTs, { apiKey, onWarn });
  if (range.error || range.startBlock == null || range.endBlock == null) {
    emitErr(
      `Failed to resolve block range: ${range.error ?? 'unknown error'}. ` +
      (apiKey ? '' : 'A free Etherscan API key (--api-key or GLNC_ETHERSCAN_KEY) lifts rate limits.'),
      2, 'block-range-failed',
    );
    return;
  }

  // ── Fetch raw rows in parallel ────────────────────────────────────────────
  if (!json) {
    process.stderr.write(c.dim('  fetching transaction history... '));
  }

  const fetchOpts = { apiKey, onWarn };
  const [normalRes, internalRes, tokenRes] = await Promise.all([
    etherscan.fetchNormalTxs(chain, address, range.startBlock, range.endBlock, fetchOpts),
    etherscan.fetchInternalTxs(chain, address, range.startBlock, range.endBlock, fetchOpts),
    etherscan.fetchTokenTxs(chain, address, range.startBlock, range.endBlock, fetchOpts),
  ]);

  // Bail out only if all three calls hit a real error AND returned nothing —
  // an empty wallet is a legitimate result.
  const allErrored =
    normalRes.error && internalRes.error && tokenRes.error &&
    normalRes.rows.length === 0 && internalRes.rows.length === 0 && tokenRes.rows.length === 0;
  if (allErrored) {
    emitErr(
      `Etherscan fetch failed: ${normalRes.error}. ` +
      (apiKey ? 'Check your API key.' : 'Set --api-key or GLNC_ETHERSCAN_KEY to lift rate limits.'),
      2, 'fetch-failed',
    );
    return;
  }

  if (!json) {
    process.stderr.write(c.dim(
      `${normalRes.rows.length} normal · ` +
      `${internalRes.rows.length} internal · ` +
      `${tokenRes.rows.length} token\n`
    ));
  }

  // ── Classify ──────────────────────────────────────────────────────────────
  let rows = classifier.classifyTransactions({
    chain,
    address,
    normalTxs: normalRes.rows,
    internalTxs: internalRes.rows,
    tokenTxs: tokenRes.rows,
  });

  // ── Enrich with historical USD prices ─────────────────────────────────────
  if (!noPrices && rows.length > 0) {
    if (!json) process.stderr.write(c.dim('  fetching historical prices...\n'));

    const reqs = [];
    for (const r of rows) {
      // Tax basis — value the user RECEIVED (tokenOut) for swaps & inflows;
      // for outflows, value of what was SENT (tokenIn). Swaps record both for
      // disambiguation in the CSV.
      if (r.tokenIn && r.amountIn)  reqs.push({ symbol: r.tokenIn,  unixSec: r.timestamp });
      if (r.tokenOut && r.amountOut) reqs.push({ symbol: r.tokenOut, unixSec: r.timestamp });
      if (r.feeNative && r.feeSymbol) reqs.push({ symbol: r.feeSymbol, unixSec: r.timestamp });
    }

    const priceMap = await prices.getHistoricalPrices(reqs, { onWarn }).catch(() => new Map());

    const lookup = (sym, ts) => {
      if (!sym) return null;
      const v = priceMap.get(`${sym.toUpperCase()}|${ts}`);
      return typeof v === 'number' && !isNaN(v) ? v : null;
    };

    for (const r of rows) {
      const inUsd  = lookup(r.tokenIn,  r.timestamp);
      const outUsd = lookup(r.tokenOut, r.timestamp);
      const inAmt  = r.amountIn  != null ? parseFloat(r.amountIn)  : null;
      const outAmt = r.amountOut != null ? parseFloat(r.amountOut) : null;

      // Choose the most reliable USD figure for the tax line. Prefer the
      // RECEIVED side (tokenOut for the user); fall back to SENT side.
      let usd = null;
      if (outUsd != null && outAmt != null && !isNaN(outAmt)) usd = outUsd * outAmt;
      else if (inUsd != null && inAmt != null && !isNaN(inAmt)) usd = inUsd * inAmt;
      r.usdValue = usd;

      if (r.feeNative && r.feeSymbol) {
        const feePrice = lookup(r.feeSymbol, r.timestamp);
        const feeAmt = parseFloat(r.feeNative);
        r.feeUsd = feePrice != null && !isNaN(feeAmt) ? feePrice * feeAmt : null;
      } else {
        r.feeUsd = null;
      }
    }
  }

  // ── Compute cost basis (FIFO) ─────────────────────────────────────────────
  // Only when --cost-basis fifo is set. Mutates rows in place adding
  // costBasisUsd / proceedsUsd / realizedGainUsd / holdingPeriod fields.
  const costBasisMethod = opts.costBasis ?? null;
  if (costBasisMethod === 'fifo') {
    // Note: --cost-basis fifo with --no-prices is rejected at parse time (args.js).
    // Blocker 5: single-chain warning when --chain was not passed explicitly.
    // opts.chain is null when the user did not specify --chain (run.js coerces
    // it to 'ethereum' for the API calls, but the raw opts.chain is still null).
    if (!json && opts.chain === null) {
      process.stderr.write(c.dim(
        '  FIFO computed against ethereum only.\n' +
        '  For multi-chain wallets, re-run per chain (--chain polygon, etc.) and combine CSVs.\n'
      ));
    }

    // Blocker 7: wrap computeCostBasis so one bad row never kills the export.
    let cbWarnings = [];
    try {
      const result = costBasisMod.computeCostBasis(rows, {
        method: 'fifo',
        ownWallets: opts.ownWallets ?? [],
      });
      cbWarnings = result.warnings;
    } catch (err) {
      warnings.push(`cost basis annotation failed: ${err?.message ?? err}`);
      if (!json) {
        process.stderr.write(c.dim(
          '  cost basis annotation failed; CSV will not include FIFO columns\n'
        ));
      }
    }
    for (const w of cbWarnings) warnings.push(w);

    if (!json) {
      process.stderr.write(c.dim(
        `  cost basis (FIFO): annotated ${rows.filter(r => r.realizedGainUsd != null).length} disposal(s)\n`
      ));

      // Blocker 1: ordinary income summary for non-own-wallet inbound transfers.
      const ownWalletsLower = new Set(
        (opts.ownWallets ?? []).map(a => a.toLowerCase())
      );
      const incomeRows = rows.filter(r =>
        (r.type === 'transfer-in' || r.type === 'native-transfer-in') &&
        !ownWalletsLower.has((r.counterparty ?? '').toLowerCase()) &&
        r.usdValue != null && Number.isFinite(r.usdValue)
      );
      if (incomeRows.length > 0) {
        const totalIncome = incomeRows.reduce((sum, r) => sum + r.usdValue, 0);
        const fmt = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        process.stderr.write(c.dim(
          `  ordinary income (inbound transfers from non-own wallets): $${fmt(totalIncome)} across ${incomeRows.length} receipt(s)\n` +
          `  → report applicable amounts on Schedule 1; glnc does not classify gift vs reward\n`
        ));
      }

      // Blocker 4: outbound transfer disposal warning.
      const outboundDisposalCount = rows.filter(r =>
        (r.type === 'transfer-out' || r.type === 'native-transfer-out') &&
        !ownWalletsLower.has((r.counterparty ?? '').toLowerCase())
      ).length;
      if (outboundDisposalCount > 0) {
        process.stderr.write(c.dim(
          `  WARNING: ${outboundDisposalCount} outbound transfer(s) treated as taxable disposals.\n` +
          `  If any went to your other wallets or exchange-deposit addresses,\n` +
          `  re-run with --own-wallets 0xA,0xB,... to avoid over-reporting gains.\n`
        ));
      }
    }
  }

  // Some rows were dropped at the 10k cap — surface this distinctly from generic warnings.
  const truncated = !!(normalRes.truncated || internalRes.truncated || tokenRes.truncated);

  // ── Emit ──────────────────────────────────────────────────────────────────
  if (json) {
    emit(wrap(SCHEMA.HISTORY, {
      chain,
      address,
      from: new Date(fromTs * 1000).toISOString(),
      to: new Date(toTs * 1000).toISOString(),
      blockRange: { start: range.startBlock, end: range.endBlock },
      rowCount: rows.length,
      truncated,
      rows,
      warnings,
    }));
    return;
  }

  const csvText = csv.rowsToCsv(rows, { chain });

  if (opts.out) {
    const target = opts.out === 'auto'
      ? defaultCsvName(address, chain)
      : opts.out;
    const abs = resolvePath(process.cwd(), target);
    try {
      writeFileSync(abs, csvText, 'utf8');
    } catch (err) {
      renderError(`Failed to write CSV to ${abs}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `  ${c.green('✓')} wrote ${c.bold(rows.length.toString())} rows to ${theme.brand(abs)}\n`
    );
  } else {
    // Stream to stdout so users can pipe directly into another tool.
    process.stdout.write(csvText);
    process.stderr.write(
      `  ${c.green('✓')} ${c.bold(rows.length.toString())} rows on stdout\n`
    );
  }

  if (truncated) {
    process.stderr.write(c.dim('  some rows were dropped (>10000 per action); narrow --from/--to to retrieve all rows\n'));
  }

  if (warnings.length > 0) {
    const cap = Math.min(warnings.length, 5);
    process.stderr.write(c.dim(`  ${warnings.length} warning(s):\n`));
    for (let i = 0; i < cap; i++) {
      process.stderr.write(c.dim(`    · ${warnings[i]}\n`));
    }
    if (warnings.length > cap) {
      process.stderr.write(c.dim(`    · …and ${warnings.length - cap} more\n`));
    }
  }
}
