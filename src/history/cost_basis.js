/**
 * src/history/cost_basis.js
 *
 * FIFO cost-basis computation for classified history rows.
 *
 * Runs AFTER price enrichment in src/history/run.js — needs row.usdValue to
 * be populated. Walks rows in chronological order (they already are), tracks
 * per-asset lots in a queue, and for each disposal pops lots FIFO to compute:
 *
 *   costBasisUsd, proceedsUsd, realizedGainUsd, holdingPeriod
 *
 * Acquisition events  → push a lot with cost basis = usdValue at acquisition.
 * Disposal events     → pop lots FIFO, sum cost basis, compute realized gain.
 * Own-wallet xfers    → consume lots silently, do not realize.
 * Approve / contract  → no economic effect, skip.
 *
 * Conservative on edge cases — missing basis lands as 0 (taxpayer overpays
 * vs underpays) and surfaces as a warning. Wrap/unwrap treated as ordinary
 * disposal+acquisition pairs; IRS treatment is debatable but this is the
 * simplest defensible default and documented in docs/tax.md.
 *
 * v1.1.0 scope: FIFO only, USD only. LIFO/HIFO and multi-currency are future.
 */

const LONG_TERM_THRESHOLD_SEC = 365 * 86400;

/**
 * Compute holding period label for a disposal.
 * @param {number} acquiredAt - unix seconds
 * @param {number} disposedAt - unix seconds
 * @returns {'short'|'long'}
 */
function classifyHolding(acquiredAt, disposedAt) {
  return (disposedAt - acquiredAt) > LONG_TERM_THRESHOLD_SEC ? 'long' : 'short';
}

/**
 * Pop up to `amount` units of `symbol` from the lot queue FIFO.
 * Mutates the queue. Returns the realized basis + diagnostic info.
 *
 * @param {Array<{quantity:number, costBasisPerUnit:number, acquiredAt:number}>} queue
 * @param {number} amount
 * @param {number} disposedAt - unix seconds, used for holding-period classification
 * @returns {{
 *   costBasis: number,
 *   unbased: number,
 *   holdings: Array<'short'|'long'>,
 * }}
 */
function popFifo(queue, amount, disposedAt) {
  let remaining = amount;
  let costBasis = 0;
  /** @type {Array<'short'|'long'>} */
  const holdings = [];

  while (remaining > 0 && queue.length > 0) {
    const EPS = Math.max(1e-9, Math.abs(remaining) * 1e-12);
    if (remaining <= EPS) break;
    const lot = queue[0];
    if (lot.quantity <= remaining + EPS) {
      // consume entire lot
      costBasis += lot.quantity * lot.costBasisPerUnit;
      holdings.push(classifyHolding(lot.acquiredAt, disposedAt));
      remaining -= lot.quantity;
      queue.shift();
    } else {
      // partial consume
      costBasis += remaining * lot.costBasisPerUnit;
      holdings.push(classifyHolding(lot.acquiredAt, disposedAt));
      lot.quantity -= remaining;
      remaining = 0;
    }
  }

  return { costBasis, unbased: remaining, holdings };
}

/**
 * Reduce a list of holding labels into a single label for the disposal row.
 * @param {Array<'short'|'long'>} holdings
 * @returns {'short'|'long'|'mixed'|null}
 */
function summarizeHoldings(holdings) {
  if (holdings.length === 0) return null;
  const set = new Set(holdings);
  if (set.size === 1) return holdings[0];
  return 'mixed';
}

/**
 * Map a classified row's `type` to its acquisition/disposal sides.
 *
 * Note the classifier's naming quirk:
 *   - swap:                 tokenIn = paid,    tokenOut = received
 *   - wrap / unwrap:        same shape as swap
 *   - transfer-out:         tokenIn = SENT, tokenOut = null
 *   - transfer-in:          tokenOut = RECEIVED, tokenIn = null
 *   - native-transfer-out:  tokenIn = SENT (native), tokenOut = null
 *   - native-transfer-in:   tokenOut = RECEIVED (native), tokenIn = null
 *
 * @param {object} row
 * @returns {{
 *   disposalSymbol: string|null, disposalAmount: number,
 *   acquisitionSymbol: string|null, acquisitionAmount: number,
 * }}
 */
function sides(row) {
  const numIn  = row.amountIn  != null ? parseFloat(row.amountIn)  : NaN;
  const numOut = row.amountOut != null ? parseFloat(row.amountOut) : NaN;

  switch (row.type) {
    case 'swap':
    case 'wrap':
    case 'unwrap':
      return {
        disposalSymbol:    row.tokenIn,
        disposalAmount:    Number.isFinite(numIn)  ? numIn  : 0,
        acquisitionSymbol: row.tokenOut,
        acquisitionAmount: Number.isFinite(numOut) ? numOut : 0,
      };
    case 'transfer-out':
    case 'native-transfer-out':
      return {
        disposalSymbol:    row.tokenIn,
        disposalAmount:    Number.isFinite(numIn) ? numIn : 0,
        acquisitionSymbol: null,
        acquisitionAmount: 0,
      };
    case 'transfer-in':
    case 'native-transfer-in':
      return {
        disposalSymbol:    null,
        disposalAmount:    0,
        acquisitionSymbol: row.tokenOut,
        acquisitionAmount: Number.isFinite(numOut) ? numOut : 0,
      };
    default:
      // approve, contract-call, other → no economic effect
      return {
        disposalSymbol: null, disposalAmount: 0,
        acquisitionSymbol: null, acquisitionAmount: 0,
      };
  }
}

/**
 * Walk classified rows in chronological order and annotate each disposal
 * with cost-basis, proceeds, realized gain, and holding period.
 *
 * Mutates `rows` in place: adds `costBasisUsd`, `proceedsUsd`,
 * `realizedGainUsd`, and `holdingPeriod` fields to disposal rows.
 *
 * @param {object[]} rows  - classified + price-enriched rows
 * @param {{
 *   method?: 'fifo'|'none',
 *   ownWallets?: string[],
 * }} [opts]
 * @returns {{ warnings: string[] }}
 */
export function computeCostBasis(rows, opts = {}) {
  const method = opts.method ?? 'none';
  if (method === 'none') return { warnings: [] };
  if (method !== 'fifo') {
    return { warnings: [`unsupported cost-basis method "${method}"; expected "fifo" or "none"`] };
  }

  const ownWallets = new Set(
    (opts.ownWallets ?? [])
      .filter(a => typeof a === 'string')
      .map(a => a.toLowerCase())
  );

  /** @type {Map<string, Array<{quantity:number, costBasisPerUnit:number, acquiredAt:number}>>} */
  const lots = new Map();
  const getLots = sym => {
    const key = (sym ?? '').toUpperCase();
    if (!lots.has(key)) lots.set(key, []);
    return lots.get(key);
  };

  const warnings = [];
  const shortHash = h => (typeof h === 'string' && h.length > 10) ? `${h.slice(0, 10)}…` : (h ?? '?');

  for (const row of rows) {
    const { disposalSymbol, disposalAmount, acquisitionSymbol, acquisitionAmount } = sides(row);

    // Identify own-wallet transfers — only relevant for transfer-* types.
    const isTransferType = row.type === 'transfer-in' || row.type === 'transfer-out'
                        || row.type === 'native-transfer-in' || row.type === 'native-transfer-out';
    const counter = (row.counterparty ?? '').toLowerCase();
    const isOwnWalletTransfer = isTransferType && counter && ownWallets.has(counter);

    // ── Disposal side ────────────────────────────────────────────────────────
    if (disposalSymbol && disposalAmount > 0) {
      if (isOwnWalletTransfer) {
        // Consume lots silently — basis travels with the user, no realization.
        const queue = getLots(disposalSymbol);
        const { unbased } = popFifo(queue, disposalAmount, row.timestamp);
        if (unbased > 0) {
          warnings.push(
            `tx ${shortHash(row.txHash)}: own-wallet send of ${unbased} ${disposalSymbol} ` +
            `had no tracked basis (originated outside the queried wallet/range)`
          );
        }
      } else {
        const proceedsUsd = (row.usdValue ?? null);
        const queue = getLots(disposalSymbol);
        const { costBasis, unbased, holdings } = popFifo(queue, disposalAmount, row.timestamp);

        row.costBasisUsd = costBasis;
        row.proceedsUsd = (proceedsUsd === null || !Number.isFinite(proceedsUsd)) ? null : proceedsUsd;
        row.realizedGainUsd = (row.proceedsUsd === null) ? null : (row.proceedsUsd - costBasis);
        row.holdingPeriod = summarizeHoldings(holdings);

        if (unbased > 0) {
          warnings.push(
            `tx ${shortHash(row.txHash)}: disposed ${unbased} ${disposalSymbol} with no prior basis ` +
            `(cost basis recorded as 0; verify before filing)`
          );
        }
        if (proceedsUsd === null) {
          warnings.push(
            `tx ${shortHash(row.txHash)}: disposed ${disposalAmount} ${disposalSymbol} ` +
            `but USD value at disposal is unknown (proceeds = null)`
          );
        }
      }
    }

    // ── Acquisition side ─────────────────────────────────────────────────────
    if (acquisitionSymbol && acquisitionAmount > 0) {
      if (isOwnWalletTransfer) {
        // Inbound own-wallet transfer with no tracked source — basis unknown.
        // Add as a zero-basis lot and warn.
        getLots(acquisitionSymbol).push({
          quantity: acquisitionAmount,
          costBasisPerUnit: 0,
          acquiredAt: row.timestamp,
        });
        warnings.push(
          `tx ${shortHash(row.txHash)}: own-wallet receive of ${acquisitionAmount} ${acquisitionSymbol} ` +
          `has no tracked basis from origin wallet (recorded as 0; pass --own-wallets to track basis across your wallets)`
        );
      } else {
        const acquisitionUsd = row.usdValue ?? null;
        const costBasisPerUnit = (acquisitionUsd != null && Number.isFinite(acquisitionUsd) && acquisitionAmount > 0)
          ? (acquisitionUsd / acquisitionAmount)
          : 0;

        getLots(acquisitionSymbol).push({
          quantity: acquisitionAmount,
          costBasisPerUnit,
          acquiredAt: row.timestamp,
        });

        // Blocker 1: surface ordinary income for pure inbound transfers from
        // non-own wallets. Staking rewards / airdrops / hard forks are ordinary
        // income at FMV on receipt (Rev. Rul. 2019-24, 2023-14).
        if (
          (row.type === 'transfer-in' || row.type === 'native-transfer-in') &&
          acquisitionUsd != null && Number.isFinite(acquisitionUsd)
        ) {
          row.incomeUsd = acquisitionUsd;
        }

        if (acquisitionUsd == null || !Number.isFinite(acquisitionUsd)) {
          warnings.push(
            `tx ${shortHash(row.txHash)}: acquired ${acquisitionAmount} ${acquisitionSymbol} ` +
            `but USD value at acquisition is unknown (cost basis recorded as 0)`
          );
        }
      }
    }
  }

  return { warnings };
}
