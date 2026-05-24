/**
 * test/_evm.objectNormalize.test.js
 *
 * Unit tests for the developer-error guard in queryQuorum that prevents the
 * "[object Object]" normalizer footgun: when the default String(v) normalizer
 * is used and the exec callback returns an object value, queryQuorum throws a
 * developer error rather than silently comparing all objects as equal.
 *
 * Tests verify:
 *   1. mode: 'majority' — object value with default normalizer → throws
 *   2. mode: 'all'      — object value with default normalizer → throws
 *   3. mode: 'any'      — whether the guard fires (read implementation; it does)
 *   4. Custom normalize — object value with normalize: JSON.stringify → succeeds
 *
 * Uses node:test + node:assert/strict — no external deps, no real RPCs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { queryQuorum } from '../src/chains/_evm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Opaque fake viemChain — exec never actually uses the client */
const FAKE_CHAIN = { id: 999, name: 'fake' };

/** An object value that, when passed through String(), yields '[object Object]' */
const OBJECT_VALUE = { some: 'object' };

/** Two URLs — enough to trigger a comparison in majority / all modes */
const TWO_URLS = ['https://r1.example.com', 'https://r2.example.com'];
const ONE_URL  = ['https://r1.example.com'];

/**
 * exec that always resolves with OBJECT_VALUE.
 * queryQuorum's normalizer will call String(OBJECT_VALUE) → '[object Object]'
 * which should trigger the developer-error guard.
 */
const execReturnsObject = (_client) => Promise.resolve(OBJECT_VALUE);

// ---------------------------------------------------------------------------
// 1. mode: 'majority' — object value with default normalizer → throws
// ---------------------------------------------------------------------------

describe("queryQuorum — object-normalize guard, mode: 'majority'", () => {
  it('default normalizer + object value → throws developer error mentioning "object value requires explicit normalize"', async () => {
    await assert.rejects(
      () =>
        queryQuorum({
          urls: TWO_URLS,
          viemChain: FAKE_CHAIN,
          exec: execReturnsObject,
          mode: 'majority',
          // No normalize provided — uses default String(v)
        }),
      (err) => {
        assert.ok(err instanceof Error, `expected Error, got ${err?.constructor?.name}`);
        assert.match(
          err.message,
          /object value requires explicit normalize/i,
          `error message must mention "object value requires explicit normalize", got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('error has isDeveloperError flag set to true', async () => {
    await assert.rejects(
      () =>
        queryQuorum({
          urls: TWO_URLS,
          viemChain: FAKE_CHAIN,
          exec: execReturnsObject,
          mode: 'majority',
        }),
      (err) => {
        assert.equal(err.isDeveloperError, true, 'isDeveloperError must be true');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. mode: 'all' — object value with default normalizer → throws
// ---------------------------------------------------------------------------

describe("queryQuorum — object-normalize guard, mode: 'all'", () => {
  it('default normalizer + object value → throws developer error', async () => {
    await assert.rejects(
      () =>
        queryQuorum({
          urls: TWO_URLS,
          viemChain: FAKE_CHAIN,
          exec: execReturnsObject,
          mode: 'all',
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /object value requires explicit normalize/i,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. mode: 'any' — guard fires there too (sequential path)
// ---------------------------------------------------------------------------

describe("queryQuorum — object-normalize guard, mode: 'any'", () => {
  // The guard is in execWithTimeout's .then() handler which runs for ALL modes.
  // mode:'any' calls execWithTimeout in a sequential loop and awaits the result.
  // When the returned normalizedKey is '[object Object]', the error is thrown
  // synchronously inside the .then(), which rejects the promise returned by
  // execWithTimeout. In mode:'any', that rejected promise is awaited directly
  // (not via allSettled), so the guard re-throw lands as an unhandled rejection
  // that propagates out of queryQuorum.
  //
  // However: the mode:'any' code path calls execWithTimeout per URL and checks
  // the result. The .then() path throws the developer error synchronously, but
  // since execWithTimeout's rejection handler catches non-isDeveloperError
  // errors and marks them 'rejected', the developer error is re-thrown.
  // The outer mode:'any' loop then propagates it.
  it('default normalizer + object value in mode:any → throws developer error', async () => {
    await assert.rejects(
      () =>
        queryQuorum({
          urls: ONE_URL,
          viemChain: FAKE_CHAIN,
          exec: execReturnsObject,
          mode: 'any',
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /object value requires explicit normalize/i,
          `expected developer error, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Custom normalize — object value should NOT throw
// ---------------------------------------------------------------------------

describe('queryQuorum — custom normalize prevents object footgun', () => {
  it('normalize: JSON.stringify allows object value without throwing', async () => {
    // With a custom normalizer, '[object Object]' is never produced.
    // JSON.stringify({some:'object'}) → '{"some":"object"}' — unique and correct.
    const result = await queryQuorum({
      urls: TWO_URLS,
      viemChain: FAKE_CHAIN,
      exec: execReturnsObject,
      mode: 'majority',
      normalize: JSON.stringify,
    });

    assert.ok(result, 'result must not be null');
    assert.deepEqual(result.value, OBJECT_VALUE, 'value must be the original object');
    // Both URLs returned the same object (by reference), both stringify the same way
    assert.equal(result.agreement, 'unanimous', 'two identical objects must agree unanimously');
    assert.deepEqual(result.disagreements, [], 'no disagreements when both agree');
  });

  it('normalize: JSON.stringify — normalizedKey is the JSON representation', async () => {
    const result = await queryQuorum({
      urls: ONE_URL,
      viemChain: FAKE_CHAIN,
      exec: execReturnsObject,
      mode: 'any',
      normalize: JSON.stringify,
    });

    assert.equal(result.sources[0].normalizedKey, JSON.stringify(OBJECT_VALUE));
  });

  it('normalize: v => v.some — custom accessor also prevents the footgun', async () => {
    const result = await queryQuorum({
      urls: TWO_URLS,
      viemChain: FAKE_CHAIN,
      exec: execReturnsObject,
      mode: 'majority',
      normalize: (v) => v.some, // extracts 'object' as the key
    });

    assert.ok(result);
    assert.equal(result.agreement, 'unanimous');
    // normalizedKey should be the result of our custom normalizer
    assert.equal(result.sources[0].normalizedKey, 'object');
  });
});
