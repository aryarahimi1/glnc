/**
 * test/solana.quorumStreaming.test.js
 *
 * Parity tests for solanaQuorum() in src/chains/solana.js.
 *
 * Mirrors test/evm.queryQuorum.test.js. Asserts that Solana's quorum helper
 * implements the same v1.2.0 streaming early-exit algorithm as EVM's
 * queryQuorum(): mode:'any' is sequential first-success; mode:'majority' and
 * mode:'all' fire in parallel and short-circuit the moment the answer is
 * decided (returning immediately rather than waiting for slow URLs).
 *
 * No network: exec callbacks are stubs that resolve/reject on timers.
 *
 * Uses node:test + node:assert/strict — no external deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { solanaQuorum } from '../src/chains/solana.js';
import { RpcDisagreementError, MAX_QUORUM_FANOUT } from '../src/chains/_evm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const URLS_3 = [
  'https://r1.example.com',
  'https://r2.example.com',
  'https://r3.example.com',
];

function resolveAfter(value, delayMs = 0) {
  return (_url, _signal) =>
    new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
}

function rejectAfter(message, delayMs = 0) {
  return (_url, _signal) =>
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), delayMs),
    );
}

/** Dispatch exec by call-order index. */
function byCallOrder(handlers) {
  let callIdx = 0;
  return (url, signal) => {
    const handler = handlers[callIdx++];
    if (!handler) throw new Error(`byCallOrder: no handler at index ${callIdx - 1}`);
    return handler(url, signal);
  };
}

/**
 * Wrap an exec function with an "invoked URLs" tracker so tests can assert
 * that mode:'any' short-circuits without touching later URLs.
 */
function trackingExec(execFn) {
  const invoked = [];
  const wrapped = (url, signal) => {
    invoked.push(url);
    return execFn(url, signal);
  };
  wrapped.invoked = invoked;
  return wrapped;
}

// ---------------------------------------------------------------------------
// mode: 'any' — sequential first-success
// ---------------------------------------------------------------------------

describe("solanaQuorum — mode: 'any'", () => {
  it('first URL succeeds — later URLs never invoked', async () => {
    const exec = trackingExec(resolveAfter('first'));

    const result = await solanaQuorum({
      mode: 'any',
      urls: URLS_3,
      exec,
      normalize: (v) => String(v),
    });

    assert.equal(result.value, 'first');
    assert.equal(result.source, URLS_3[0]);
    assert.equal(result.agreement, 'single');
    assert.equal(result.mode, 'any');
    assert.deepEqual(result.disagreements, []);

    // Only the first URL was touched.
    assert.deepEqual(exec.invoked, [URLS_3[0]]);

    // All 3 URLs must appear in sources; the two later ones marked 'not-tried'.
    assert.equal(result.sources.length, 3);
    assert.equal(result.sources[0].status, 'fulfilled');
    assert.equal(result.sources[1].status, 'rejected');
    assert.equal(result.sources[1].error, 'not-tried');
    assert.equal(result.sources[2].status, 'rejected');
    assert.equal(result.sources[2].error, 'not-tried');
  });

  it('first URL fails, second succeeds — falls through, third untried', async () => {
    const exec = trackingExec(byCallOrder([
      rejectAfter('connection refused'),
      resolveAfter('goodValue'),
    ]));

    const result = await solanaQuorum({
      mode: 'any',
      urls: URLS_3,
      exec,
      normalize: (v) => String(v),
    });

    assert.equal(result.value, 'goodValue');
    assert.equal(result.source, URLS_3[1]);
    assert.equal(result.agreement, 'single');

    // First two URLs touched; third never invoked.
    assert.deepEqual(exec.invoked, [URLS_3[0], URLS_3[1]]);

    const r1 = result.sources.find((s) => s.url === URLS_3[0]);
    const r2 = result.sources.find((s) => s.url === URLS_3[1]);
    const r3 = result.sources.find((s) => s.url === URLS_3[2]);
    assert.equal(r1.status, 'rejected');
    assert.match(r1.error, /connection refused/);
    assert.equal(r2.status, 'fulfilled');
    assert.equal(r2.value, 'goodValue');
    assert.equal(r3.status, 'rejected');
    assert.equal(r3.error, 'not-tried');
  });

  it('all URLs fail — throws Error mentioning all reasons', async () => {
    const exec = byCallOrder([
      rejectAfter('provider down'),
      rejectAfter('rate limited'),
      rejectAfter('timeout'),
    ]);

    await assert.rejects(
      () => solanaQuorum({
        mode: 'any',
        urls: URLS_3,
        exec,
        normalize: (v) => String(v),
      }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof RpcDisagreementError));
        assert.match(err.message, /all Solana RPCs failed/i);
        assert.match(err.message, /provider down/);
        assert.match(err.message, /rate limited/);
        assert.match(err.message, /timeout/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// mode: 'majority' — early-exit streaming
// ---------------------------------------------------------------------------

describe("solanaQuorum — mode: 'majority'", () => {
  // Streaming win: r1+r2 agree fast; r3 is slow. We MUST return before r3
  // resolves — that's the whole point of the EVM-parity rewrite.
  it('3 URLs, 2 agree fast, 1 slow — returns immediately, does NOT wait for slow URL', async () => {
    const exec = byCallOrder([
      resolveAfter('A', 10),
      resolveAfter('A', 20),
      resolveAfter('A', 5000), // 5s — if we waited, the test would time out
    ]);

    const t0 = Date.now();
    const result = await solanaQuorum({
      mode: 'majority',
      urls: URLS_3,
      exec,
      normalize: (v) => String(v),
    });
    const elapsed = Date.now() - t0;

    assert.equal(result.value, 'A');
    assert.equal(result.agreement, 'unanimous');
    assert.deepEqual(result.disagreements, []);

    // Sanity bound: returning within 200ms proves we did NOT wait for r3 (5000ms).
    assert.ok(elapsed < 200, `expected early-exit < 200ms, got ${elapsed}ms`);

    assert.equal(result.sources.length, 3);
    assert.equal(result.sources.filter((s) => s.status === 'fulfilled').length, 2);
    const r3 = result.sources.find((s) => s.url === URLS_3[2]);
    assert.equal(r3.status, 'rejected');
    assert.match(r3.error, /aborted/);
  });

  // 2-of-3 majority with a dissenter: same early-exit semantics.
  it('3 URLs, 2 agree on A and 1 returns B (slow) — picks A, B aborted', async () => {
    const exec = byCallOrder([
      resolveAfter('A', 10),
      resolveAfter('A', 20),
      resolveAfter('B', 5000),
    ]);

    const t0 = Date.now();
    const result = await solanaQuorum({
      mode: 'majority',
      urls: URLS_3,
      exec,
      normalize: (v) => String(v),
    });
    const elapsed = Date.now() - t0;

    assert.equal(result.value, 'A');
    assert.ok(elapsed < 200, `expected early-exit < 200ms, got ${elapsed}ms`);

    const r3 = result.sources.find((s) => s.url === URLS_3[2]);
    assert.equal(r3.status, 'rejected');
    assert.match(r3.error, /aborted/);
  });

  // 1-1-1 split: no majority possible. Pick plurality winner by arrival order.
  it('3 URLs all disagree — picks first-in-order, agreement: plurality', async () => {
    const exec = byCallOrder([
      resolveAfter('X', 10),
      resolveAfter('Y', 20),
      resolveAfter('Z', 30),
    ]);

    const result = await solanaQuorum({
      mode: 'majority',
      urls: URLS_3,
      exec,
      normalize: (v) => String(v),
    });

    assert.equal(result.value, 'X');
    assert.equal(result.source, URLS_3[0]);
    assert.equal(result.agreement, 'plurality');
    assert.equal(result.disagreements.length, 2);
    const disagreementUrls = result.disagreements.map((d) => d.url);
    assert.ok(disagreementUrls.includes(URLS_3[1]));
    assert.ok(disagreementUrls.includes(URLS_3[2]));
  });

  it('2 of 3 URLs fail, 1 succeeds — picks the success, agreement: single', async () => {
    const exec = byCallOrder([
      rejectAfter('connection refused', 5),
      resolveAfter('goodValue', 10),
      rejectAfter('timeout', 15),
    ]);

    const result = await solanaQuorum({
      mode: 'majority',
      urls: URLS_3,
      exec,
      normalize: (v) => String(v),
    });

    assert.equal(result.value, 'goodValue');
    assert.equal(result.source, URLS_3[1]);
    assert.equal(result.agreement, 'single');
    assert.deepEqual(result.disagreements, []);
  });
});

// ---------------------------------------------------------------------------
// mode: 'all' — fail-fast on disagreement
// ---------------------------------------------------------------------------

describe("solanaQuorum — mode: 'all'", () => {
  it('3 URLs all agree — returns value, agreement: unanimous', async () => {
    const exec = byCallOrder([
      resolveAfter('consensus', 5),
      resolveAfter('consensus', 10),
      resolveAfter('consensus', 15),
    ]);

    const result = await solanaQuorum({
      mode: 'all',
      urls: URLS_3,
      exec,
      normalize: (v) => String(v),
    });

    assert.equal(result.value, 'consensus');
    assert.equal(result.agreement, 'unanimous');
    assert.equal(result.mode, 'all');
    assert.deepEqual(result.disagreements, []);
  });

  // Fail-fast: first two disagree, third is slow. The error MUST throw before
  // the third URL resolves.
  it('first two URLs disagree, third slow — fails fast, does NOT wait for third', async () => {
    const exec = byCallOrder([
      resolveAfter('alpha', 10),
      resolveAfter('beta', 20),
      resolveAfter('gamma', 5000), // 5s — must be aborted
    ]);

    const t0 = Date.now();
    await assert.rejects(
      () => solanaQuorum({
        mode: 'all',
        urls: URLS_3,
        exec,
        normalize: (v) => String(v),
      }),
      (err) => {
        assert.ok(err instanceof RpcDisagreementError, `expected RpcDisagreementError, got ${err.constructor.name}`);
        // Two values seen at fail-fast point — third was aborted.
        assert.equal(err.values.length, 2);
        const keys = err.values.map((v) => v.normalizedKey).sort();
        assert.deepEqual(keys, ['alpha', 'beta']);
        return true;
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 200, `expected fail-fast < 200ms, got ${elapsed}ms`);
  });

  it('3 URLs all fail — throws plain Error, NOT RpcDisagreementError', async () => {
    const exec = byCallOrder([
      rejectAfter('down1', 5),
      rejectAfter('down2', 10),
      rejectAfter('down3', 15),
    ]);

    await assert.rejects(
      () => solanaQuorum({
        mode: 'all',
        urls: URLS_3,
        exec,
        normalize: (v) => String(v),
      }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof RpcDisagreementError));
        assert.match(err.message, /all Solana RPCs failed/i);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Object-normalize footgun (matches EVM behavior)
// ---------------------------------------------------------------------------

describe('solanaQuorum — object-normalize guard', () => {
  it('default normalizer + object value (mode:majority) → throws developer error', async () => {
    const exec = (_url, _signal) => Promise.resolve({ some: 'object' });
    await assert.rejects(
      () => solanaQuorum({
        mode: 'majority',
        urls: URLS_3,
        exec,
        // No normalize — default String(v) yields '[object Object]'.
      }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /object value requires explicit normalize/i);
        assert.equal(err.isDeveloperError, true);
        return true;
      },
    );
  });

  it('default normalizer + object value (mode:any) → throws developer error', async () => {
    const exec = (_url, _signal) => Promise.resolve({ some: 'object' });
    await assert.rejects(
      () => solanaQuorum({
        mode: 'any',
        urls: [URLS_3[0]],
        exec,
      }),
      (err) => {
        assert.match(err.message, /object value requires explicit normalize/i);
        return true;
      },
    );
  });

  it('custom normalize (JSON.stringify) — object value works', async () => {
    const OBJ = { ok: true };
    const exec = (_url, _signal) => Promise.resolve(OBJ);
    const result = await solanaQuorum({
      mode: 'majority',
      urls: URLS_3,
      exec,
      normalize: JSON.stringify,
    });
    assert.deepEqual(result.value, OBJ);
    assert.equal(result.agreement, 'unanimous');
  });
});

// ---------------------------------------------------------------------------
// Fanout cap
// ---------------------------------------------------------------------------

describe('solanaQuorum — fanout cap', () => {
  it(`urls.length > ${MAX_QUORUM_FANOUT} throws`, async () => {
    const urls = Array.from({ length: MAX_QUORUM_FANOUT + 1 }, (_, i) => `https://r${i}.example.com`);
    await assert.rejects(
      () => solanaQuorum({
        mode: 'any',
        urls,
        exec: resolveAfter('x'),
        normalize: (v) => String(v),
      }),
      (err) => {
        assert.match(err.message, new RegExp(`urls\\.length must be between 1 and ${MAX_QUORUM_FANOUT}`));
        return true;
      },
    );
  });

  it('urls.length === 0 throws', async () => {
    await assert.rejects(
      () => solanaQuorum({
        mode: 'any',
        urls: [],
        exec: resolveAfter('x'),
        normalize: (v) => String(v),
      }),
      (err) => {
        assert.match(err.message, new RegExp(`urls\\.length must be between 1 and ${MAX_QUORUM_FANOUT}`));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Legacy positional signature parity (used by getBalances / getTransaction)
// ---------------------------------------------------------------------------

describe('solanaQuorum — positional signature (legacy call sites)', () => {
  it('solanaQuorum(mode, exec, normalize) still works', async () => {
    // The existing getBalances / getTransaction call sites use this shape.
    const exec = (_url, _signal) => Promise.resolve('positional-ok');
    const result = await solanaQuorum(
      'any',
      exec,
      (v) => String(v),
    );
    assert.equal(result.value, 'positional-ok');
    assert.equal(result.mode, 'any');
  });
});
