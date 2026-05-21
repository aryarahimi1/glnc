/**
 * test/cost_basis.test.js
 *
 * Unit tests for src/history/cost_basis.js — the FIFO lot-tracker that
 * annotates classified history rows with cost basis, proceeds, realized
 * gain, and holding period.
 *
 * Uses node:test + node:assert/strict — no external deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeCostBasis } from '../src/history/cost_basis.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a row in roughly the shape the classifier produces. Defaults match
// what `transfer-out` would look like with the tokenIn naming quirk preserved.
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

// Convenience: ETH acquisition at a given price and timestamp.
function buyEth(amount, usdPrice, timestamp, hashSuffix = '01') {
  return row({
    timestamp,
    type:     'transfer-in',
    tokenOut: 'ETH',
    amountOut: String(amount),
    usdValue: amount * usdPrice,
    txHash:   '0x' + hashSuffix.padStart(64, '0'),
  });
}

// Convenience: ETH disposal of `amount` at given USD value, with given timestamp.
function sellEth(amount, usdProceeds, timestamp, hashSuffix = '02') {
  return row({
    timestamp,
    type:    'transfer-out',
    tokenIn: 'ETH',
    amountIn: String(amount),
    usdValue: usdProceeds,
    txHash:   '0x' + hashSuffix.padStart(64, '0'),
  });
}

const ONE_YEAR = 365 * 86400;

// ---------------------------------------------------------------------------
// method = 'none' (default) — no-op
// ---------------------------------------------------------------------------

describe('computeCostBasis — method:none', () => {
  it('returns no warnings and annotates nothing', () => {
    const rows = [buyEth(1, 2000, 1_700_000_000), sellEth(1, 3000, 1_700_100_000)];
    const { warnings } = computeCostBasis(rows, { method: 'none' });
    assert.deepEqual(warnings, []);
    for (const r of rows) {
      assert.equal(r.costBasisUsd,     undefined);
      assert.equal(r.proceedsUsd,      undefined);
      assert.equal(r.realizedGainUsd,  undefined);
      assert.equal(r.holdingPeriod,    undefined);
    }
  });

  it('defaults to none when method is omitted', () => {
    const rows = [buyEth(1, 2000, 1_700_000_000), sellEth(1, 3000, 1_700_100_000)];
    const { warnings } = computeCostBasis(rows);
    assert.deepEqual(warnings, []);
    assert.equal(rows[1].realizedGainUsd, undefined);
  });

  it('rejects unsupported methods with a warning instead of throwing', () => {
    const { warnings } = computeCostBasis([], { method: 'lifo' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unsupported cost-basis method/);
  });
});

// ---------------------------------------------------------------------------
// Pure FIFO
// ---------------------------------------------------------------------------

describe('computeCostBasis — fifo (basic)', () => {
  it('realizes gain against the oldest lot first', () => {
    const t0 = 1_700_000_000;
    const rows = [
      buyEth(1, 1000, t0,         '01'), // buy 1 ETH @ $1000
      buyEth(1, 2000, t0 + 1000,  '02'), // buy 1 ETH @ $2000
      sellEth(1, 3000, t0 + 2000, '03'), // sell 1 ETH @ $3000 — should consume the $1000 lot
    ];

    const { warnings } = computeCostBasis(rows, { method: 'fifo' });
    assert.deepEqual(warnings, []);

    const sell = rows[2];
    assert.equal(sell.costBasisUsd,    1000);
    assert.equal(sell.proceedsUsd,     3000);
    assert.equal(sell.realizedGainUsd, 2000);
    assert.equal(sell.holdingPeriod,   'short');
  });

  it('handles partial-lot consumption', () => {
    const t0 = 1_700_000_000;
    const rows = [
      buyEth(2, 1000, t0,         '01'), // buy 2 ETH @ $1000 each ($2000 basis for the lot)
      sellEth(0.5, 2000, t0 + 100, '02'), // sell 0.5 ETH @ $2000 proceeds
    ];

    computeCostBasis(rows, { method: 'fifo' });
    const sell = rows[1];
    assert.equal(sell.costBasisUsd,    500);  // 0.5 of a $1000-per-unit lot
    assert.equal(sell.proceedsUsd,     2000);
    assert.equal(sell.realizedGainUsd, 1500);
  });

  it('spans multiple lots when one is not enough', () => {
    const t0 = 1_700_000_000;
    const rows = [
      buyEth(1, 1000, t0,         '01'),
      buyEth(1, 2000, t0 + 100,   '02'),
      sellEth(1.5, 4500, t0 + 200, '03'), // takes all of lot 1 + half of lot 2
    ];
    computeCostBasis(rows, { method: 'fifo' });

    const sell = rows[2];
    assert.equal(sell.costBasisUsd,    1000 + 1000); // full lot 1 + 0.5 * 2000
    assert.equal(sell.proceedsUsd,     4500);
    assert.equal(sell.realizedGainUsd, 2500);
    assert.equal(sell.holdingPeriod,   'short');
  });
});

// ---------------------------------------------------------------------------
// Holding period classification
// ---------------------------------------------------------------------------

describe('computeCostBasis — holding period', () => {
  it('classifies disposal at >365d after acquisition as long-term', () => {
    const t0 = 1_700_000_000;
    const rows = [
      buyEth(1, 1000, t0,                  '01'),
      sellEth(1, 2000, t0 + ONE_YEAR + 1,  '02'),
    ];
    computeCostBasis(rows, { method: 'fifo' });
    assert.equal(rows[1].holdingPeriod, 'long');
  });

  it('classifies disposal at exactly 365d as short-term (boundary)', () => {
    const t0 = 1_700_000_000;
    const rows = [
      buyEth(1, 1000, t0,             '01'),
      sellEth(1, 2000, t0 + ONE_YEAR, '02'),
    ];
    computeCostBasis(rows, { method: 'fifo' });
    assert.equal(rows[1].holdingPeriod, 'short');
  });

  it('returns "mixed" when consumed lots span both short and long', () => {
    const t0 = 1_700_000_000;
    const rows = [
      buyEth(1, 1000, t0,                       '01'), // long-term by the time of the sell
      buyEth(1, 2000, t0 + ONE_YEAR + 10,       '02'), // short-term by the time of the sell
      sellEth(2, 6000, t0 + ONE_YEAR + 100_000, '03'),
    ];
    computeCostBasis(rows, { method: 'fifo' });
    assert.equal(rows[2].holdingPeriod, 'mixed');
  });
});

// ---------------------------------------------------------------------------
// Edge cases — missing basis, missing USD, approve, contract-call
// ---------------------------------------------------------------------------

describe('computeCostBasis — edge cases', () => {
  it('disposal without prior basis warns and uses 0 cost basis', () => {
    const rows = [sellEth(1, 2000, 1_700_000_000, '01')];
    const { warnings } = computeCostBasis(rows, { method: 'fifo' });
    assert.equal(rows[0].costBasisUsd,    0);
    assert.equal(rows[0].realizedGainUsd, 2000);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no prior basis/);
  });

  it('acquisition with null usdValue warns and adds zero-basis lot', () => {
    const t0 = 1_700_000_000;
    const rows = [
      // Inbound airdrop-style: amount present, USD value unknown.
      row({
        timestamp: t0,
        type:      'transfer-in',
        tokenOut:  'AIRDROP',
        amountOut: '100',
        usdValue:  null,
        txHash:    '0x' + '01'.padStart(64, '0'),
      }),
      // Later disposal — should realize all of proceeds as gain because basis is 0.
      row({
        timestamp: t0 + 1000,
        type:      'transfer-out',
        tokenIn:   'AIRDROP',
        amountIn:  '100',
        usdValue:  500,
        txHash:    '0x' + '02'.padStart(64, '0'),
      }),
    ];
    const { warnings } = computeCostBasis(rows, { method: 'fifo' });
    assert.equal(rows[1].costBasisUsd,    0);
    assert.equal(rows[1].realizedGainUsd, 500);
    assert.ok(warnings.some(w => /USD value at acquisition is unknown/.test(w)));
  });

  it('skips approve / contract-call rows entirely (no fields added)', () => {
    const rows = [
      row({ type: 'approve',       tokenIn: null }),
      row({ type: 'contract-call', tokenIn: null }),
    ];
    const { warnings } = computeCostBasis(rows, { method: 'fifo' });
    assert.deepEqual(warnings, []);
    for (const r of rows) {
      assert.equal(r.costBasisUsd,     undefined);
      assert.equal(r.realizedGainUsd,  undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Own-wallet transfers
// ---------------------------------------------------------------------------

describe('computeCostBasis — own-wallet transfers', () => {
  it('outbound transfer to an own-wallet does not realize a gain', () => {
    const t0 = 1_700_000_000;
    const ownAddr = '0x' + '11'.repeat(20);
    const rows = [
      buyEth(1, 1000, t0, '01'),
      // Send 1 ETH to your other wallet — should consume the lot silently.
      row({
        timestamp:    t0 + 100,
        type:         'transfer-out',
        tokenIn:      'ETH',
        amountIn:     '1',
        usdValue:     2000,  // would be a $1000 gain if treated as a real disposal
        counterparty: ownAddr,
        txHash:       '0x' + '02'.padStart(64, '0'),
      }),
    ];
    computeCostBasis(rows, { method: 'fifo', ownWallets: [ownAddr] });
    assert.equal(rows[1].realizedGainUsd, undefined, 'own-wallet send must not set realized gain');
    assert.equal(rows[1].costBasisUsd,    undefined);
  });

  it('inbound transfer from an own-wallet adds a zero-basis lot and warns', () => {
    const t0 = 1_700_000_000;
    const ownAddr = '0x' + '22'.repeat(20);
    const rows = [
      row({
        timestamp:    t0,
        type:         'transfer-in',
        tokenOut:     'ETH',
        amountOut:    '1',
        usdValue:     2000,
        counterparty: ownAddr,
        txHash:       '0x' + '01'.padStart(64, '0'),
      }),
      sellEth(1, 3000, t0 + 100, '02'),
    ];
    const { warnings } = computeCostBasis(rows, { method: 'fifo', ownWallets: [ownAddr] });
    // The own-wallet receive is treated as zero-basis (origin unknown).
    assert.equal(rows[1].costBasisUsd,    0);
    assert.equal(rows[1].realizedGainUsd, 3000);
    assert.ok(warnings.some(w => /own-wallet receive/.test(w)));
  });
});

// ---------------------------------------------------------------------------
// Swaps — disposal + acquisition in the same row
// ---------------------------------------------------------------------------

describe('computeCostBasis — swaps', () => {
  it('swap realizes gain on the sold side and seeds a lot on the bought side', () => {
    const t0 = 1_700_000_000;
    const rows = [
      buyEth(1, 1000, t0, '01'),
      // Swap 1 ETH (worth $2000 at the time) for 2000 USDC
      row({
        timestamp: t0 + 100,
        type:      'swap',
        tokenIn:   'ETH',  amountIn:  '1',
        tokenOut:  'USDC', amountOut: '2000',
        usdValue:  2000,
        txHash:    '0x' + '02'.padStart(64, '0'),
      }),
      // Later sell of the USDC for $2001 — should realize $1 of gain ($1 per unit * 2000 - 2000)
      row({
        timestamp: t0 + 200,
        type:      'transfer-out',
        tokenIn:   'USDC',
        amountIn:  '2000',
        usdValue:  2001,
        txHash:    '0x' + '03'.padStart(64, '0'),
      }),
    ];
    computeCostBasis(rows, { method: 'fifo' });

    // Swap realizes the ETH side.
    assert.equal(rows[1].costBasisUsd,    1000);
    assert.equal(rows[1].proceedsUsd,     2000);
    assert.equal(rows[1].realizedGainUsd, 1000);

    // Later USDC sell should pop the lot seeded by the swap.
    assert.equal(rows[2].costBasisUsd,    2000);
    assert.equal(rows[2].proceedsUsd,     2001);
    assert.equal(rows[2].realizedGainUsd, 1);
  });
});

// ---------------------------------------------------------------------------
// income_usd — Blocker 1
// ---------------------------------------------------------------------------

describe('computeCostBasis — income_usd', () => {
  it('sets incomeUsd for transfer-in from non-own wallet when usdValue is set', () => {
    const t0 = 1_700_000_000;
    const rows = [
      row({
        timestamp: t0,
        type:      'transfer-in',
        tokenOut:  'ETH',
        amountOut: '1',
        usdValue:  2000,
        txHash:    '0x' + '01'.padStart(64, '0'),
      }),
    ];
    computeCostBasis(rows, { method: 'fifo' });
    assert.equal(rows[0].incomeUsd, 2000);
  });

  it('sets incomeUsd for native-transfer-in from non-own wallet', () => {
    const t0 = 1_700_000_000;
    const rows = [
      row({
        timestamp: t0,
        type:      'native-transfer-in',
        tokenOut:  'ETH',
        amountOut: '0.5',
        usdValue:  1000,
        txHash:    '0x' + '01'.padStart(64, '0'),
      }),
    ];
    computeCostBasis(rows, { method: 'fifo' });
    assert.equal(rows[0].incomeUsd, 1000);
  });

  it('does NOT set incomeUsd for swap', () => {
    const t0 = 1_700_000_000;
    const rows = [
      buyEth(1, 1000, t0, '01'),
      row({
        timestamp: t0 + 100,
        type:      'swap',
        tokenIn:   'ETH',  amountIn:  '1',
        tokenOut:  'USDC', amountOut: '2000',
        usdValue:  2000,
        txHash:    '0x' + '02'.padStart(64, '0'),
      }),
    ];
    computeCostBasis(rows, { method: 'fifo' });
    assert.equal(rows[1].incomeUsd, undefined);
  });

  it('does NOT set incomeUsd for wrap', () => {
    const t0 = 1_700_000_000;
    const rows = [
      buyEth(1, 1000, t0, '01'),
      row({
        timestamp: t0 + 100,
        type:      'wrap',
        tokenIn:   'ETH',  amountIn:  '1',
        tokenOut:  'WETH', amountOut: '1',
        usdValue:  2000,
        txHash:    '0x' + '02'.padStart(64, '0'),
      }),
    ];
    computeCostBasis(rows, { method: 'fifo' });
    assert.equal(rows[1].incomeUsd, undefined);
  });

  it('does NOT set incomeUsd for transfer-out', () => {
    const t0 = 1_700_000_000;
    const rows = [
      buyEth(1, 1000, t0, '01'),
      sellEth(1, 2000, t0 + 100, '02'),
    ];
    computeCostBasis(rows, { method: 'fifo' });
    assert.equal(rows[1].incomeUsd, undefined);
  });

  it('does NOT set incomeUsd for own-wallet inbound transfers', () => {
    const t0 = 1_700_000_000;
    const ownAddr = '0x' + '33'.repeat(20);
    const rows = [
      row({
        timestamp:    t0,
        type:         'transfer-in',
        tokenOut:     'ETH',
        amountOut:    '1',
        usdValue:     2000,
        counterparty: ownAddr,
        txHash:       '0x' + '01'.padStart(64, '0'),
      }),
    ];
    computeCostBasis(rows, { method: 'fifo', ownWallets: [ownAddr] });
    assert.equal(rows[0].incomeUsd, undefined, 'own-wallet receive must not set incomeUsd');
  });

  it('does NOT set incomeUsd when usdValue is null', () => {
    const t0 = 1_700_000_000;
    const rows = [
      row({
        timestamp: t0,
        type:      'transfer-in',
        tokenOut:  'MYSTERY',
        amountOut: '100',
        usdValue:  null,
        txHash:    '0x' + '01'.padStart(64, '0'),
      }),
    ];
    computeCostBasis(rows, { method: 'fifo' });
    assert.equal(rows[0].incomeUsd, undefined);
  });
});

// ---------------------------------------------------------------------------
// Float drift — I1
// ---------------------------------------------------------------------------

describe('computeCostBasis — float drift (EPS)', () => {
  it('1000 ETH bought then 1000 sequential sells of 0.001 ETH produce no spurious warnings', () => {
    const t0 = 1_700_000_000;
    const rows = [];
    // Single buy of 1000 ETH
    rows.push(row({
      timestamp: t0,
      type:      'transfer-in',
      tokenOut:  'ETH',
      amountOut: '1000',
      usdValue:  1_000_000,
      txHash:    '0x' + '01'.padStart(64, '0'),
    }));
    // 1000 disposals of 0.001 ETH each
    for (let i = 0; i < 1000; i++) {
      rows.push(row({
        timestamp: t0 + i + 1,
        type:      'transfer-out',
        tokenIn:   'ETH',
        amountIn:  '0.001',
        usdValue:  1.1,
        txHash:    '0x' + String(i + 2).padStart(64, '0'),
      }));
    }
    const { warnings } = computeCostBasis(rows, { method: 'fifo' });
    // No spurious "no prior basis" warnings
    const noPriorBasisWarnings = warnings.filter(w => /no prior basis/.test(w));
    assert.equal(noPriorBasisWarnings.length, 0, `unexpected "no prior basis" warnings: ${noPriorBasisWarnings.join(', ')}`);
  });
});
