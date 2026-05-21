/**
 * test/history_integration.test.js
 *
 * Integration tests: computeCostBasis + rowsToCsv end-to-end with synthetic
 * fixture rows. No network calls — purely in-process.
 *
 * Uses node:test + node:assert/strict — no external deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeCostBasis } from '../src/history/cost_basis.js';
import { rowsToCsv, CSV_COLUMNS } from '../src/history/csv.js';

// ---------------------------------------------------------------------------
// Helpers — same shape as the classifier produces
// ---------------------------------------------------------------------------

function row(over = {}) {
  return {
    timestamp:    1_700_000_000,
    isoTimestamp: '2023-11-14T22:13:20Z',
    chain:        'ethereum',
    txHash:       '0x' + 'a'.repeat(64),
    blockNumber:  18_500_000,
    type:         'other',
    tokenIn:      null,
    amountIn:     null,
    tokenOut:     null,
    amountOut:    null,
    counterparty: null,
    feeNative:    null,
    feeSymbol:    null,
    contract:     null,
    method:       null,
    usdValue:     null,
    feeUsd:       null,
    ...over,
  };
}

const OWN_WALLET = '0x' + '99'.repeat(20);
const T0 = 1_700_000_000;
const ONE_YEAR = 365 * 86400;

/**
 * Build a synthetic 7-row fixture:
 *  0: buy 2 ETH @ $1500 each  (transfer-in, from exchange)
 *  1: airdrop of 100 TOKEN    (transfer-in, from unknown — ordinary income)
 *  2: own-wallet receive 0.5 ETH from OWN_WALLET (should not incomeUsd)
 *  3: swap 0.5 ETH → 1000 USDC  (disposal of ETH, acquisition of USDC)
 *  4: sell 1 ETH @ $4000        (disposal — $1500 basis, $4000 proceeds, $2500 gain)
 *  5: own-wallet send 0.5 ETH to OWN_WALLET (consume lot silently)
 *  6: sell 100 TOKEN @ $250     (disposal of TOKEN, $0 basis because airdrop had known price)
 */
function buildFixture() {
  return [
    row({
      timestamp: T0,
      type:      'transfer-in',
      tokenOut:  'ETH',
      amountOut: '2',
      usdValue:  3000,   // 2 ETH @ $1500
      txHash:    '0x' + '01'.padStart(64, '0'),
    }),
    row({
      timestamp: T0 + 100,
      type:      'transfer-in',
      tokenOut:  'TOKEN',
      amountOut: '100',
      usdValue:  200,   // airdrop FMV $200 at receipt
      txHash:    '0x' + '02'.padStart(64, '0'),
    }),
    row({
      timestamp:    T0 + 200,
      type:         'transfer-in',
      tokenOut:     'ETH',
      amountOut:    '0.5',
      usdValue:     800,
      counterparty: OWN_WALLET,
      txHash:       '0x' + '03'.padStart(64, '0'),
    }),
    row({
      timestamp: T0 + 300,
      type:      'swap',
      tokenIn:   'ETH',   amountIn:  '0.5',
      tokenOut:  'USDC',  amountOut: '1000',
      usdValue:  1000,    // proceeds of 0.5 ETH swap
      txHash:    '0x' + '04'.padStart(64, '0'),
    }),
    row({
      timestamp: T0 + ONE_YEAR + 1,  // long-term disposal
      type:      'transfer-out',
      tokenIn:   'ETH',
      amountIn:  '1',
      usdValue:  4000,
      txHash:    '0x' + '05'.padStart(64, '0'),
    }),
    row({
      timestamp:    T0 + ONE_YEAR + 2,
      type:         'transfer-out',
      tokenIn:      'ETH',
      amountIn:     '0.5',
      usdValue:     2100,
      counterparty: OWN_WALLET,
      txHash:       '0x' + '06'.padStart(64, '0'),
    }),
    row({
      timestamp: T0 + ONE_YEAR + 3,
      type:      'transfer-out',
      tokenIn:   'TOKEN',
      amountIn:  '100',
      usdValue:  250,
      txHash:    '0x' + '07'.padStart(64, '0'),
    }),
  ];
}

// ---------------------------------------------------------------------------
// Integration suite
// ---------------------------------------------------------------------------

describe('history integration — computeCostBasis + rowsToCsv', () => {
  it('CSV header includes all 23 columns including income_usd', () => {
    const rows = buildFixture();
    computeCostBasis(rows, { method: 'fifo', ownWallets: [OWN_WALLET] });
    const csv = rowsToCsv(rows);
    const header = csv.split('\r\n')[0];
    const cols = header.split(',');

    assert.equal(cols.length, CSV_COLUMNS.length, `expected ${CSV_COLUMNS.length} columns, got ${cols.length}`);
    assert.ok(cols.includes('income_usd'),        'income_usd must be in header');
    assert.ok(cols.includes('cost_basis_usd'),     'cost_basis_usd must be in header');
    assert.ok(cols.includes('realized_gain_usd'),  'realized_gain_usd must be in header');
    assert.ok(cols.includes('holding_period'),     'holding_period must be in header');
    assert.ok(cols.includes('proceeds_usd'),       'proceeds_usd must be in header');
  });

  it('ETH disposal row (row 4) has correct realized gain and long holding period', () => {
    const rows = buildFixture();
    computeCostBasis(rows, { method: 'fifo', ownWallets: [OWN_WALLET] });

    // row[4]: sell 1 ETH.
    // Lots consumed FIFO:
    //   lot 0: 2 ETH @ $1500 each (row 0 buy) → first 1 ETH consumed = basis $1500
    // realizedGain = $4000 - $1500 = $2500
    const dispRow = rows[4];
    assert.equal(dispRow.costBasisUsd,    1500,   'cost basis must be $1500 (FIFO)');
    assert.equal(dispRow.proceedsUsd,     4000,   'proceeds must be $4000');
    assert.equal(dispRow.realizedGainUsd, 2500,   'realized gain must be $2500');
    assert.equal(dispRow.holdingPeriod,   'long',  'holding period must be long (>365d)');
  });

  it('airdrop row (row 1) has income_usd populated', () => {
    const rows = buildFixture();
    computeCostBasis(rows, { method: 'fifo', ownWallets: [OWN_WALLET] });
    // row[1] is transfer-in from non-own wallet with usdValue=200
    assert.equal(rows[1].incomeUsd, 200, 'airdrop row must have incomeUsd = 200');
  });

  it('own-wallet inbound (row 2) has no income_usd and no realized gain', () => {
    const rows = buildFixture();
    computeCostBasis(rows, { method: 'fifo', ownWallets: [OWN_WALLET] });
    assert.equal(rows[2].incomeUsd,       undefined, 'own-wallet receive must not set incomeUsd');
    assert.equal(rows[2].realizedGainUsd, undefined, 'own-wallet receive must not set realizedGainUsd');
  });

  it('own-wallet outbound (row 5) has no realized_gain_usd set', () => {
    const rows = buildFixture();
    computeCostBasis(rows, { method: 'fifo', ownWallets: [OWN_WALLET] });
    assert.equal(rows[5].realizedGainUsd, undefined, 'own-wallet send must not set realizedGainUsd');
    assert.equal(rows[5].costBasisUsd,    undefined, 'own-wallet send must not set costBasisUsd');
  });

  it('CSV data rows match column count for all rows', () => {
    const rows = buildFixture();
    computeCostBasis(rows, { method: 'fifo', ownWallets: [OWN_WALLET] });
    const csv = rowsToCsv(rows);
    const lines = csv.split('\r\n').filter(Boolean);
    const expectedCols = CSV_COLUMNS.length;
    for (let i = 1; i < lines.length; i++) {
      // Count commas not inside quotes — use a simple split for unquoted rows.
      const cols = lines[i].split(',').length;
      assert.equal(cols, expectedCols, `row ${i} has ${cols} columns, expected ${expectedCols}`);
    }
  });
});
