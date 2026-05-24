/**
 * test/evm.queryQuorum.test.js
 *
 * Unit tests for the queryQuorum helper in src/chains/_evm.js.
 *
 * Design: exec functions are mocked — no real RPC or viem clients are
 * constructed. queryQuorum builds a viem client per URL internally, but the
 * exec callback abstracts the client away, so we simply ignore the client
 * argument and return synthetic values or reject as needed.
 *
 * Uses node:test + node:assert/strict — no external deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { queryQuorum, RpcDisagreementError, MAX_QUORUM_FANOUT } from '../src/chains/_evm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake viemChain object. queryQuorum passes it to makeClient which
 * passes it to viem's createPublicClient — but our mocked exec never actually
 * invokes any client methods, so an opaque object is fine.
 */
const FAKE_CHAIN = { id: 1, name: 'fake' };

/**
 * Create an exec function that resolves with `value` after `delayMs`.
 *
 * @param {*}      value
 * @param {number} [delayMs]
 * @returns {(client: *) => Promise<*>}
 */
function resolveAfter(value, delayMs = 0) {
  return (_client) =>
    new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
}

/**
 * Create an exec function that rejects with `message` after `delayMs`.
 *
 * @param {string} message
 * @param {number} [delayMs]
 * @returns {(client: *) => Promise<never>}
 */
function rejectAfter(message, delayMs = 0) {
  return (_client) =>
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), delayMs),
    );
}

/**
 * Build an exec function that dispatches by call-order index.
 * `handlers[0]` is called for the first URL, `handlers[1]` for the second, etc.
 *
 * @param {Array<(client:*)=>Promise<*>>} handlers
 * @returns {(client:*)=>Promise<*>}
 */
function byCallOrder(handlers) {
  let callIdx = 0;
  return (client) => {
    const handler = handlers[callIdx++];
    if (!handler) throw new Error(`byCallOrder: no handler at index ${callIdx - 1}`);
    return handler(client);
  };
}

// ---------------------------------------------------------------------------
// 1. mode: 'any' — single URL, fast success
// ---------------------------------------------------------------------------

describe("queryQuorum — mode: 'any'", () => {
  it('single URL, fast success — returns expected shape with agreement: single', async () => {
    const result = await queryQuorum({
      urls: ['https://rpc1.example.com'],
      viemChain: FAKE_CHAIN,
      exec: resolveAfter(42n),
      mode: 'any',
    });

    assert.equal(result.value, 42n);
    assert.equal(result.source, 'https://rpc1.example.com');
    assert.equal(result.agreement, 'single');
    assert.equal(result.mode, 'any');
    assert.deepEqual(result.disagreements, []);

    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, 'https://rpc1.example.com');
    assert.equal(result.sources[0].status, 'fulfilled');
    assert.equal(result.sources[0].value, 42n);
    assert.equal(result.sources[0].normalizedKey, '42');
  });

  // 2. mode: 'any' — first URL fails, second succeeds → sequential fallback
  it('first URL fails, second succeeds — picks second, first recorded with error, no third URL', async () => {
    const exec = byCallOrder([
      rejectAfter('connection refused'),
      resolveAfter('goodValue'),
    ]);

    const result = await queryQuorum({
      urls: ['https://a.example.com', 'https://b.example.com', 'https://c.example.com'],
      viemChain: FAKE_CHAIN,
      exec,
      mode: 'any',
    });

    assert.equal(result.value, 'goodValue');
    assert.equal(result.source, 'https://b.example.com');
    assert.equal(result.agreement, 'single');
    assert.equal(result.mode, 'any');

    const aSrc = result.sources.find((s) => s.url === 'https://a.example.com');
    const bSrc = result.sources.find((s) => s.url === 'https://b.example.com');
    const cSrc = result.sources.find((s) => s.url === 'https://c.example.com');
    assert.equal(aSrc.status, 'rejected');
    assert.match(aSrc.error, /connection refused/);
    assert.equal(bSrc.status, 'fulfilled');
    assert.equal(bSrc.value, 'goodValue');
    // c was never queried — must be marked not-tried, not just aborted
    assert.equal(cSrc.status, 'rejected');
    assert.equal(cSrc.error, 'not-tried');
  });

  // 3. mode: 'any' — all fail
  it('all URLs fail — throws Error mentioning all reasons', async () => {
    const exec = byCallOrder([
      rejectAfter('provider down'),
      rejectAfter('rate limited'),
    ]);

    await assert.rejects(
      () =>
        queryQuorum({
          urls: ['https://a.example.com', 'https://b.example.com'],
          viemChain: FAKE_CHAIN,
          exec,
          mode: 'any',
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof RpcDisagreementError));
        assert.match(err.message, /all RPC providers failed/i);
        assert.match(err.message, /provider down/);
        assert.match(err.message, /rate limited/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 4-7. mode: 'majority'
// ---------------------------------------------------------------------------

describe("queryQuorum — mode: 'majority'", () => {
  // 4. 3 URLs all agree → unanimous, empty disagreements
  //
  // With the early-exit optimisation, queryQuorum fires all 3 requests in
  // parallel but returns as soon as ⌈N/2⌉+1 = 2 responses agree on the same
  // key.  The third request is aborted (status:'rejected', error:'aborted') so
  // the process is not held alive by its in-flight undici socket.
  it('3 URLs all agree — agreement: unanimous, empty disagreements', async () => {
    const exec = byCallOrder([
      resolveAfter('valueA'),
      resolveAfter('valueA'),
      resolveAfter('valueA'),
    ]);

    const result = await queryQuorum({
      urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
      viemChain: FAKE_CHAIN,
      exec,
      mode: 'majority',
    });

    assert.equal(result.value, 'valueA');
    assert.equal(result.agreement, 'unanimous');
    assert.equal(result.mode, 'majority');
    assert.deepEqual(result.disagreements, []);
    // Early exit: only 2 fulfilled responses needed to reach majority threshold.
    // The third URL is aborted — it still appears in sources, but as rejected.
    assert.equal(result.sources.length, 3); // all 3 URLs are represented
    assert.equal(result.sources.filter((s) => s.status === 'fulfilled').length, 2);
    const abortedSrc = result.sources.find((s) => s.status === 'rejected');
    assert.ok(abortedSrc, 'third URL should appear as rejected/aborted');
  });

  // 5. 3 URLs, 2 agree on A, 1 returns B → picks A with majority
  //
  // When all three respond instantly, the early-exit optimisation sees r1+r2
  // agree on 'A' (2 votes = majority threshold) and returns before r3's 'B'
  // arrives.  Disagreements are empty because we never received the dissenting
  // response; the third URL is recorded as aborted.
  //
  // To observe the disagreement in sources, give the dissenter a longer delay
  // than the two agreeing URLs — see the separate staggered-delay test below.
  it('3 URLs, 2 agree on A and 1 returns B — picks A, r3 aborted before B arrives', async () => {
    const exec = byCallOrder([
      resolveAfter('A'),
      resolveAfter('A'),
      resolveAfter('B'),
    ]);

    const result = await queryQuorum({
      urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
      viemChain: FAKE_CHAIN,
      exec,
      mode: 'majority',
    });

    assert.equal(result.value, 'A');
    // All 3 sources must be present — the aborting URL is recorded as rejected.
    assert.equal(result.sources.length, 3);
    const r1 = result.sources.find((s) => s.url === 'https://r1.example.com');
    const r2 = result.sources.find((s) => s.url === 'https://r2.example.com');
    const r3 = result.sources.find((s) => s.url === 'https://r3.example.com');
    assert.equal(r1.status, 'fulfilled');
    assert.equal(r2.status, 'fulfilled');
    // r3 was aborted before its 'B' response arrived.
    assert.equal(r3.status, 'rejected');
    assert.match(r3.error, /aborted/);
  });

  // 5b. Staggered delays: r1+r2 agree on A (fast), r3 returns B (slow) — disagrees
  //
  // When the dissenter arrives AFTER the majority winner is decided, it is aborted
  // and never reaches sources.  When the dissenter arrives BEFORE, it is recorded.
  // This test stubs r3 with a long delay so it is genuinely superseded by the exit.
  it('3 URLs with staggered delays — r1+r2 agree fast, r3 disagrees but arrives too late', async () => {
    const exec = byCallOrder([
      resolveAfter('A', 0),
      resolveAfter('A', 5),
      resolveAfter('B', 200), // slow — will be aborted before responding
    ]);

    const result = await queryQuorum({
      urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
      viemChain: FAKE_CHAIN,
      exec,
      mode: 'majority',
    });

    assert.equal(result.value, 'A');
    assert.equal(result.agreement, 'unanimous'); // both responses that arrived agree
    assert.deepEqual(result.disagreements, []);
    const r3 = result.sources.find((s) => s.url === 'https://r3.example.com');
    assert.equal(r3.status, 'rejected');
    assert.match(r3.error, /aborted/);
  });

  // 6. 3 URLs all disagree (1/1/1 split) → picks first-in-order, agreement: 'plurality'
  it('3 URLs all disagree — picks first-in-order, agreement: plurality', async () => {
    const exec = byCallOrder([
      resolveAfter('X'),
      resolveAfter('Y'),
      resolveAfter('Z'),
    ]);

    const result = await queryQuorum({
      urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
      viemChain: FAKE_CHAIN,
      exec,
      mode: 'majority',
    });

    assert.equal(result.value, 'X');
    assert.equal(result.source, 'https://r1.example.com');
    assert.equal(result.agreement, 'plurality');
    assert.equal(result.disagreements.length, 2);
    const disagreementUrls = result.disagreements.map((d) => d.url);
    assert.ok(disagreementUrls.includes('https://r2.example.com'));
    assert.ok(disagreementUrls.includes('https://r3.example.com'));
  });

  // 7. 2 of 3 fail, 1 success → picks it, agreement: 'single'
  it('2 of 3 URLs fail, 1 succeeds — picks the success, agreement: single', async () => {
    const exec = byCallOrder([
      rejectAfter('connection refused'),
      resolveAfter('goodValue'),
      rejectAfter('timeout'),
    ]);

    const result = await queryQuorum({
      urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
      viemChain: FAKE_CHAIN,
      exec,
      mode: 'majority',
    });

    assert.equal(result.value, 'goodValue');
    assert.equal(result.source, 'https://r2.example.com');
    assert.equal(result.agreement, 'single');
    assert.deepEqual(result.disagreements, []);
    const r1 = result.sources.find((s) => s.url === 'https://r1.example.com');
    const r3 = result.sources.find((s) => s.url === 'https://r3.example.com');
    assert.equal(r1.status, 'rejected');
    assert.equal(r3.status, 'rejected');
  });
});

// ---------------------------------------------------------------------------
// 8-9. mode: 'all'
// ---------------------------------------------------------------------------

describe("queryQuorum — mode: 'all'", () => {
  // 8. 3 URLs agree → value returned, agreement: unanimous
  it('3 URLs all agree — returns value, agreement: unanimous', async () => {
    const exec = byCallOrder([
      resolveAfter('consensus'),
      resolveAfter('consensus'),
      resolveAfter('consensus'),
    ]);

    const result = await queryQuorum({
      urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
      viemChain: FAKE_CHAIN,
      exec,
      mode: 'all',
    });

    assert.equal(result.value, 'consensus');
    assert.equal(result.agreement, 'unanimous');
    assert.equal(result.mode, 'all');
    assert.deepEqual(result.disagreements, []);
  });

  // 9. 3 URLs, one disagrees → throws RpcDisagreementError with diverging values
  it('3 URLs, one disagrees — throws RpcDisagreementError', async () => {
    const exec = byCallOrder([
      resolveAfter('correct'),
      resolveAfter('correct'),
      resolveAfter('WRONG'),
    ]);

    await assert.rejects(
      () =>
        queryQuorum({
          urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
          viemChain: FAKE_CHAIN,
          exec,
          mode: 'all',
        }),
      (err) => {
        assert.ok(err instanceof RpcDisagreementError, `Expected RpcDisagreementError, got ${err.constructor.name}`);
        assert.equal(err.name, 'RpcDisagreementError');
        assert.ok(Array.isArray(err.urls));
        assert.equal(err.urls.length, 3);
        assert.ok(Array.isArray(err.values));
        // values contains all successful responses
        const keys = err.values.map((v) => v.normalizedKey);
        assert.ok(keys.includes('correct'));
        assert.ok(keys.includes('WRONG'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Custom normalize — BigInt values compared by stringification
// ---------------------------------------------------------------------------

describe('queryQuorum — custom normalize', () => {
  it('BigInt 12n from two URLs agrees when normalize uses String()', async () => {
    const exec = byCallOrder([
      resolveAfter(12n),
      resolveAfter(12n),
      resolveAfter(12n),
    ]);

    const result = await queryQuorum({
      urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
      viemChain: FAKE_CHAIN,
      exec,
      mode: 'majority',
      normalize: (v) => String(v),
    });

    assert.equal(result.value, 12n);
    assert.equal(result.agreement, 'unanimous');
    assert.deepEqual(result.disagreements, []);
    // Verify normalizedKey was correctly computed
    assert.equal(result.sources[0].normalizedKey, '12');
  });

  // With the early-exit optimisation: r1+r2 both resolve to 12n (majority
  // threshold = 2), so we return before r3's 13n arrives.  r3 is aborted.
  // agreement is 'unanimous' among the two responses that were received.
  // To observe the disagreement you need r3 to arrive before the threshold is
  // reached — e.g. use staggered delays (see test 5b above for the pattern).
  it('BigInt disagreement — 12n vs 13n — 13n aborted by early exit', async () => {
    const exec = byCallOrder([
      resolveAfter(12n),
      resolveAfter(12n),
      resolveAfter(13n),
    ]);

    const result = await queryQuorum({
      urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
      viemChain: FAKE_CHAIN,
      exec,
      mode: 'majority',
      normalize: (v) => String(v),
    });

    assert.equal(result.value, 12n);
    // r1+r2 reached the majority threshold; r3 was aborted before responding.
    assert.equal(result.agreement, 'unanimous');
    assert.deepEqual(result.disagreements, []);
    const r3 = result.sources.find((s) => s.url === 'https://r3.example.com');
    assert.equal(r3.status, 'rejected');
    assert.match(r3.error, /aborted/);
  });
});

// ---------------------------------------------------------------------------
// 11. Timeout — hanging URL marked rejected, others succeed
// ---------------------------------------------------------------------------

describe('queryQuorum — timeout', () => {
  it('one URL hangs past timeoutMs, others succeed — hanging URL marked rejected', async () => {
    // Use a very short timeout (50ms). url[1] hangs for 500ms, others are fast.
    const exec = byCallOrder([
      resolveAfter('fast1', 5),
      resolveAfter('fast2', 500), // will exceed timeoutMs
      resolveAfter('fast3', 5),
    ]);

    const result = await queryQuorum({
      urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
      viemChain: FAKE_CHAIN,
      exec,
      mode: 'majority',
      normalize: (v) => v,
      timeoutMs: 50,
    });

    // r1 and r3 succeed with different values; r2 times out
    const r2 = result.sources.find((s) => s.url === 'https://r2.example.com');
    assert.equal(r2.status, 'rejected');
    assert.match(r2.error, /timeout/i);

    // r1 and r3 both fulfilled
    const r1 = result.sources.find((s) => s.url === 'https://r1.example.com');
    const r3 = result.sources.find((s) => s.url === 'https://r3.example.com');
    assert.equal(r1.status, 'fulfilled');
    assert.equal(r3.status, 'fulfilled');
  });
});

// ---------------------------------------------------------------------------
// 12. Fanout cap — 17 URLs throws, 1 URL works
// ---------------------------------------------------------------------------

describe('queryQuorum — fanout cap', () => {
  it(`urls.length > ${MAX_QUORUM_FANOUT} throws before exec is called`, async () => {
    const urls = Array.from({ length: MAX_QUORUM_FANOUT + 1 }, (_, i) => `https://r${i}.example.com`);
    await assert.rejects(
      () =>
        queryQuorum({
          urls,
          viemChain: FAKE_CHAIN,
          exec: resolveAfter('x'),
          mode: 'any',
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, new RegExp(`urls\\.length must be between 1 and ${MAX_QUORUM_FANOUT}`));
        return true;
      },
    );
  });

  it('urls.length === 0 throws', async () => {
    await assert.rejects(
      () =>
        queryQuorum({
          urls: [],
          viemChain: FAKE_CHAIN,
          exec: resolveAfter('x'),
          mode: 'any',
        }),
      (err) => {
        assert.match(err.message, new RegExp(`urls\\.length must be between 1 and ${MAX_QUORUM_FANOUT}`));
        return true;
      },
    );
  });

  it('urls.length === 1 works (lower bound)', async () => {
    const result = await queryQuorum({
      urls: ['https://only.example.com'],
      viemChain: FAKE_CHAIN,
      exec: resolveAfter('ok'),
      mode: 'any',
    });
    assert.equal(result.value, 'ok');
  });
});

// ---------------------------------------------------------------------------
// 13. mode: 'all' — partial-fail and all-fail
// ---------------------------------------------------------------------------

describe("queryQuorum — mode: 'all' edge cases", () => {
  it('3 URLs, 2 fail and 1 succeeds — returns the success with agreement: single', async () => {
    const exec = byCallOrder([
      rejectAfter('boom1'),
      resolveAfter('lonelyOk'),
      rejectAfter('boom2'),
    ]);

    const result = await queryQuorum({
      urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
      viemChain: FAKE_CHAIN,
      exec,
      mode: 'all',
    });

    assert.equal(result.value, 'lonelyOk');
    assert.equal(result.source, 'https://r2.example.com');
    assert.equal(result.agreement, 'single');
    assert.equal(result.mode, 'all');
    assert.deepEqual(result.disagreements, []);
  });

  it('3 URLs all fail — throws plain Error, NOT RpcDisagreementError', async () => {
    const exec = byCallOrder([
      rejectAfter('down1'),
      rejectAfter('down2'),
      rejectAfter('down3'),
    ]);

    await assert.rejects(
      () =>
        queryQuorum({
          urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
          viemChain: FAKE_CHAIN,
          exec,
          mode: 'all',
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof RpcDisagreementError));
        assert.match(err.message, /all RPC providers failed/i);
        return true;
      },
    );
  });

  // With the early-exit optimisation: r1 returns 'alpha', r2 returns 'beta'
  // — that is the second distinct key, so RpcDisagreementError is thrown
  // immediately (fail-fast) with the 2 values seen so far.  r3 is aborted.
  it('3 URLs with 3 distinct values — RpcDisagreementError thrown on second distinct key', async () => {
    const exec = byCallOrder([
      resolveAfter('alpha'),
      resolveAfter('beta'),
      resolveAfter('gamma'),
    ]);

    await assert.rejects(
      () =>
        queryQuorum({
          urls: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'],
          viemChain: FAKE_CHAIN,
          exec,
          mode: 'all',
        }),
      (err) => {
        assert.ok(err instanceof RpcDisagreementError);
        // Fail-fast fires on the second distinct key; third URL is aborted.
        assert.equal(err.values.length, 2);
        const keys = err.values.map((v) => v.normalizedKey).sort();
        assert.deepEqual(keys, ['alpha', 'beta']);
        return true;
      },
    );
  });
});
