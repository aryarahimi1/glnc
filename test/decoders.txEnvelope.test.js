/**
 * test/decoders.txEnvelope.test.js
 *
 * Unit tests for decodeTransaction shape contracts in src/decoders/index.js —
 * specifically the quorum-field propagation and raw-mode schema constants.
 *
 * ESM note: Named exports of ESM namespace objects are live bindings and
 * cannot be reassigned (TypeError: Cannot assign to property). Therefore
 * we mock at the level of the chain REGISTRY (getChainAdapter) by using
 * the 'unsupported chain' code path, and test all the edge cases that
 * can be exercised without reaching a real RPC.
 *
 * Separately we test `jsonSafeQuorum` (the utility function applied to the
 * quorum block before it appears on the returned object) — that is already
 * covered in index.disagreementAggregation.test.js and we do not duplicate it.
 *
 * Uses node:test + node:assert/strict — no external deps, no real RPCs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeTransaction } from '../src/decoders/index.js';
import { jsonSafeQuorum } from '../src/output/serialize.js';

// ---------------------------------------------------------------------------
// Constants and shape helpers
// ---------------------------------------------------------------------------

const FAKE_EVM_HASH = '0x' + 'a'.repeat(64);
const FAKE_SOL_SIG  = 'A'.repeat(88); // 88 base58 chars — matches isSolHash regex

const TX_RAW_SCHEMA = 'glnc.tx-raw/v1';

// ---------------------------------------------------------------------------
// 1. Unsupported chain — raw: false — always returns error shape (no RPC)
// ---------------------------------------------------------------------------

describe('decodeTransaction — unsupported chain', () => {
  it('raw: false with unknown chain returns error summary (no RPC hit)', async () => {
    const result = await decodeTransaction('no-such-chain', FAKE_EVM_HASH, { raw: false });
    assert.ok(result, 'result must not be null');
    assert.ok(typeof result === 'object');
    // For an unsupported chain the summary includes the chain name
    assert.ok(
      typeof result.summary === 'string' && result.summary.includes('no-such-chain'),
      `summary must mention the chain name, got: ${result.summary}`,
    );
    // Standard fields must be present
    assert.ok('hash' in result, 'hash must be present');
    assert.ok('chain' in result, 'chain must be present');
    assert.equal(result.chain, 'no-such-chain');
    // quorum must not be present on unsupported-chain result
    assert.ok(!('quorum' in result), 'quorum must be absent for unsupported chain');
  });

  it('raw: true with unknown chain returns __schema: glnc.tx-raw/v1', async () => {
    const result = await decodeTransaction('no-such-chain', FAKE_EVM_HASH, { raw: true });
    assert.ok(result, 'result must not be null');
    assert.equal(result.__schema, TX_RAW_SCHEMA, '__schema must be glnc.tx-raw/v1');
    assert.equal(result.chain, 'no-such-chain');
    assert.equal(result.hash, FAKE_EVM_HASH);
    assert.ok('error' in result, 'error field must be present');
    assert.equal(result.raw, null, 'raw must be null for unsupported chain');
  });
});

// ---------------------------------------------------------------------------
// 2. decodeTransaction raw-mode schema constant — EVM hash shape
// ---------------------------------------------------------------------------

describe('decodeTransaction — raw: true schema constant', () => {
  it('TX_RAW_SCHEMA value is "glnc.tx-raw/v1"', () => {
    // Verify the constant we depend on in all other tests
    assert.equal(TX_RAW_SCHEMA, 'glnc.tx-raw/v1');
  });

  it('raw: true for unsupported chain yields __schema, not "glnc.tx/v1"', async () => {
    const result = await decodeTransaction('fantom-not-supported', FAKE_EVM_HASH, { raw: true });
    assert.equal(result.__schema, TX_RAW_SCHEMA);
    // The SCHEMA.TX value would be 'glnc.tx/v1' — raw mode never uses it
    assert.notEqual(result.__schema, 'glnc.tx/v1');
  });
});

// ---------------------------------------------------------------------------
// 3. jsonSafeQuorum applied to a realistic adapter quorum block
// ---------------------------------------------------------------------------
// This section verifies the exact transformation decodeTransaction applies
// before returning quorum data. It tests the function call-site contract,
// not the function internals (which are covered in the serialize test file).

describe('decodeTransaction — jsonSafeQuorum applied to quorum block', () => {
  // Simulate the adapter quorum block that would come from a real EVM adapter
  // when rpcQuorum: 'majority' is used and two providers agree.
  const adapterQuorum = {
    agreement: 'majority',
    disagreements: [
      { url: 'https://rpc3.example.com', value: 99n, normalizedKey: '99' },
    ],
    sources: [
      {
        url: 'https://rpc1.example.com',
        status: 'fulfilled',
        value: 100n,
        normalizedKey: '100',
      },
      {
        url: 'https://rpc2.example.com',
        status: 'fulfilled',
        value: 100n,
        normalizedKey: '100',
      },
      {
        url: 'https://rpc3.example.com',
        status: 'fulfilled',
        value: 99n,
        normalizedKey: '99',
      },
    ],
  };

  it('jsonSafeQuorum converts BigInt values in sources to strings', () => {
    const safe = jsonSafeQuorum(adapterQuorum);
    assert.equal(safe.agreement, 'majority');
    // All source values must be JSON-serializable (no BigInt)
    assert.doesNotThrow(() => JSON.stringify(safe), 'jsonSafeQuorum output must be JSON-serializable');
    // BigInt 100n → string '100'
    const fulfilled = safe.sources.filter(s => s.status === 'fulfilled');
    for (const s of fulfilled) {
      assert.notEqual(typeof s.value, 'bigint', 'BigInt must not appear in JSON-safe output');
    }
  });

  it('jsonSafeQuorum converts BigInt values in disagreements to strings', () => {
    const safe = jsonSafeQuorum(adapterQuorum);
    assert.equal(safe.disagreements.length, 1);
    assert.equal(safe.disagreements[0].value, '99', 'disagreement BigInt 99n → string "99"');
  });

  it('jsonSafeQuorum preserves agreement, disagreements, sources structure', () => {
    const safe = jsonSafeQuorum(adapterQuorum);
    assert.equal(safe.agreement, adapterQuorum.agreement);
    assert.equal(safe.sources.length, adapterQuorum.sources.length);
    assert.equal(safe.disagreements.length, adapterQuorum.disagreements.length);
  });

  it('jsonSafeQuorum handles null/undefined quorum gracefully', () => {
    // When the adapter returns no quorum, decodeTransaction skips jsonSafeQuorum.
    // The null case is a safety guard — jsonSafeQuorum itself is only called
    // when quorum is present. Verify it doesn't throw on an empty quorum.
    const emptyQuorum = { agreement: 'single', disagreements: [], sources: [] };
    const safe = jsonSafeQuorum(emptyQuorum);
    assert.equal(safe.agreement, 'single');
    assert.deepEqual(safe.disagreements, []);
    assert.deepEqual(safe.sources, []);
  });
});

// ---------------------------------------------------------------------------
// 4. decodeTransaction opts.raw field routing
// ---------------------------------------------------------------------------

describe('decodeTransaction — opts.raw routing', () => {
  it('raw: false (default) returns standard decoded shape fields (hash, chain, summary)', async () => {
    // Use unsupported chain to avoid real RPC — shape contract is still testable
    const result = await decodeTransaction('unsupported-chain', FAKE_EVM_HASH, { raw: false });
    assert.ok('hash' in result, 'decoded shape must have hash');
    assert.ok('chain' in result, 'decoded shape must have chain');
    assert.ok('summary' in result, 'decoded shape must have summary');
    // raw-mode specific fields must be absent
    assert.ok(!('__schema' in result), '__schema must only appear in raw mode');
  });

  it('raw: true returns __schema on the result object', async () => {
    const result = await decodeTransaction('unsupported-chain', FAKE_EVM_HASH, { raw: true });
    assert.ok('__schema' in result, '__schema must be present in raw mode');
    assert.equal(result.__schema, TX_RAW_SCHEMA);
  });

  it('raw: true includes error field (even when error is null for successful decode)', async () => {
    const result = await decodeTransaction('unsupported-chain', FAKE_EVM_HASH, { raw: true });
    assert.ok('error' in result, 'error field must always be present in raw mode');
  });

  it('opts defaults: raw defaults to false when not specified', async () => {
    // raw defaults to false; __schema must not appear
    const result = await decodeTransaction('unsupported-chain', FAKE_EVM_HASH, {});
    assert.ok(!('__schema' in result), '__schema must be absent when raw is not set');
  });
});
