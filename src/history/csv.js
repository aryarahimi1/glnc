/**
 * src/history/csv.js
 *
 * CSV writer for classified history rows. RFC 4180-ish: quote fields with
 * comma/quote/CR/LF, double embedded quotes, CRLF line endings. No I/O.
 */

/** Standard column order — exported so other modules can reference it.
 *
 * Cost-basis columns (cost_basis_usd, proceeds_usd, realized_gain_usd,
 * holding_period) are appended at the end. They are populated only when
 * --cost-basis fifo is set; otherwise they stay empty so the CSV remains
 * backward compatible. */
export const CSV_COLUMNS = [
  'timestamp', 'iso_timestamp', 'chain', 'tx_hash', 'type',
  'token_in', 'amount_in', 'token_out', 'amount_out',
  'usd_value', 'counterparty', 'counterparty_name',
  'fee_native', 'fee_symbol', 'fee_usd',
  'block_number', 'contract', 'method',
  'cost_basis_usd', 'proceeds_usd', 'realized_gain_usd', 'holding_period',
  'income_usd',
];

const COLUMN_TO_ROW_KEY = {
  timestamp:         'timestamp',
  iso_timestamp:     'isoTimestamp',
  chain:             'chain',
  tx_hash:           'txHash',
  type:              'type',
  token_in:          'tokenIn',
  amount_in:         'amountIn',
  token_out:         'tokenOut',
  amount_out:        'amountOut',
  usd_value:         'usdValue',
  counterparty:      'counterparty',
  counterparty_name: 'counterpartyName',
  fee_native:        'feeNative',
  fee_symbol:        'feeSymbol',
  fee_usd:           'feeUsd',
  block_number:      'blockNumber',
  contract:          'contract',
  method:            'method',
  cost_basis_usd:    'costBasisUsd',
  proceeds_usd:      'proceedsUsd',
  realized_gain_usd: 'realizedGainUsd',
  holding_period:    'holdingPeriod',
  income_usd:        'incomeUsd',
};

const USD_COLUMNS = new Set(['usd_value', 'fee_usd', 'cost_basis_usd', 'proceeds_usd', 'realized_gain_usd', 'income_usd']);

// Fixed 4-decimal precision, never scientific. toFixed is exact for the
// IEEE-754 inputs we'll see in practice.
function formatUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return n.toFixed(4);
}

function escapeField(v) {
  if (v === null || v === undefined) return '';
  let s;
  if (typeof v === 'string')        s = v;
  else if (typeof v === 'number')   s = Number.isFinite(v) ? String(v) : '';
  else if (typeof v === 'bigint')   s = v.toString();
  else if (typeof v === 'boolean')  s = v ? 'true' : 'false';
  else                              s = JSON.stringify(v);

  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCells(row) {
  const cells = [];
  for (const col of CSV_COLUMNS) {
    let v = row[COLUMN_TO_ROW_KEY[col]];
    if (USD_COLUMNS.has(col)) v = formatUsd(v);
    cells.push(escapeField(v));
  }
  return cells;
}

/**
 * Convert an array of classified rows into a CSV string.
 * @param {object[]} rows
 * @param {{ chain?: string }} [_opts] - chain hint for header annotation (reserved)
 * @returns {string}
 */
export function rowsToCsv(rows, _opts) {
  // Canonical column names are simple snake_case → no escaping needed for header.
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows ?? []) lines.push(rowToCells(r).join(','));
  return lines.join('\r\n') + '\r\n';
}
