/**
 * test/args.test.js
 *
 * Unit tests for src/cli/args.js — argument parsing and validation.
 *
 * Uses node:test + node:assert/strict — no external deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, ParseError } from '../src/cli/args.js';

// ---------------------------------------------------------------------------
// --cost-basis fifo + --no-prices must be rejected at parse time (Blocker 6)
// ---------------------------------------------------------------------------

describe('parseArgs — --cost-basis fifo with --no-prices', () => {
  it('throws ParseError when --cost-basis fifo and --no-prices are both passed', () => {
    assert.throws(
      () => parseArgs(['history', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '--cost-basis', 'fifo', '--no-prices']),
      (err) => {
        assert.ok(err instanceof ParseError, 'expected ParseError');
        assert.match(err.message, /cannot be combined with --no-prices/);
        assert.equal(err.exitCode, 1);
        return true;
      }
    );
  });

  it('throws ParseError for the = form too', () => {
    assert.throws(
      () => parseArgs(['history', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '--cost-basis=fifo', '--no-prices']),
      (err) => {
        assert.ok(err instanceof ParseError);
        assert.match(err.message, /cannot be combined with --no-prices/);
        return true;
      }
    );
  });

  it('allows --cost-basis none with --no-prices', () => {
    const args = parseArgs(['history', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '--cost-basis', 'none', '--no-prices']);
    assert.equal(args.costBasis, 'none');
    assert.equal(args.noPrices, true);
  });

  it('allows --cost-basis fifo without --no-prices', () => {
    const args = parseArgs(['history', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '--cost-basis', 'fifo']);
    assert.equal(args.costBasis, 'fifo');
    assert.equal(args.noPrices, false);
  });
});

// ---------------------------------------------------------------------------
// --cost-basis invalid value
// ---------------------------------------------------------------------------

describe('parseArgs — --cost-basis validation', () => {
  it('throws ParseError for unknown cost-basis method', () => {
    assert.throws(
      () => parseArgs(['history', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '--cost-basis', 'lifo']),
      (err) => {
        assert.ok(err instanceof ParseError);
        assert.match(err.message, /--cost-basis must be "fifo" or "none"/);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// --raw command-scope validation (v1.2.0)
// ---------------------------------------------------------------------------

describe('parseArgs — --raw is tx-only', () => {
  it('throws ParseError when --raw is used on balance', () => {
    assert.throws(
      () => parseArgs(['balance', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '--raw']),
      (err) => {
        assert.ok(err instanceof ParseError);
        assert.match(err.message, /--raw is only supported on/);
        return true;
      }
    );
  });

  it('allows --raw on tx and implies --json', () => {
    const args = parseArgs(['tx', '0xabc', '--raw']);
    assert.equal(args.txRaw, true);
    assert.equal(args.json, true);
  });
});

// ---------------------------------------------------------------------------
// --rpc-quorum command-scope validation (v1.2.0)
// ---------------------------------------------------------------------------

describe('parseArgs — --rpc-quorum is balance/tx-only', () => {
  it('throws on gas', () => {
    assert.throws(
      () => parseArgs(['gas', '--rpc-quorum', 'majority']),
      (err) => {
        assert.ok(err instanceof ParseError);
        assert.match(err.message, /--rpc-quorum is only supported on/);
        return true;
      }
    );
  });

  it('throws on history', () => {
    assert.throws(
      () => parseArgs(['history', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '--rpc-quorum=majority']),
      (err) => {
        assert.ok(err instanceof ParseError);
        assert.match(err.message, /--rpc-quorum is only supported on/);
        return true;
      }
    );
  });

  it('throws on alert', () => {
    assert.throws(
      () => parseArgs(['alert', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '--rpc-quorum=majority']),
      (err) => {
        assert.ok(err instanceof ParseError);
        assert.match(err.message, /--rpc-quorum is only supported on/);
        return true;
      }
    );
  });

  it('allows --rpc-quorum majority on balance', () => {
    const args = parseArgs(['balance', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '--rpc-quorum', 'majority']);
    assert.equal(args.rpcQuorum, 'majority');
  });

  it('allows --rpc-quorum=all on tx', () => {
    const args = parseArgs(['tx', '0xabc', '--rpc-quorum=all']);
    assert.equal(args.rpcQuorum, 'all');
  });
});
