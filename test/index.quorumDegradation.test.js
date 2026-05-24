/**
 * test/index.quorumDegradation.test.js
 *
 * Unit tests for the v1.2.0 quorum-degradation surface:
 *   - collectDegradationsFromWallets — aggregator-level walker
 *   - buildDegradationEntry           — one-shot helper used by runTx
 *   - formatDegradationWarning        — stderr line formatter
 *   - maybeEmitDegradationWarnings    — TTY/structured-output gating
 *
 * A degraded quorum is one where the user asked for majority/all and fewer
 * providers fulfilled than the policy needs. The aggregator must surface this
 * (so --strict can exit 3) while pretty/structured output stays uncluttered.
 *
 * Uses node:test + node:assert/strict — no external deps, no real RPCs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectDegradationsFromWallets,
  buildDegradationEntry,
  formatDegradationWarning,
  maybeEmitDegradationWarnings,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a wallet-result entry whose quorum block reflects a single fulfilled
 * provider out of three queried (the canonical silent-downgrade scenario).
 */
function makeDegradedQuorum(chain) {
  return {
    chain,
    result: {
      source: 'https://r1.example.com',
      quorum: {
        agreement: 'single',
        mode: 'majority',
        disagreements: [],
        sources: [
          { url: 'https://r1.example.com', status: 'fulfilled', value: '1', normalizedKey: '1' },
          { url: 'https://r2.example.com', status: 'rejected', error: 'timeout' },
          { url: 'https://r3.example.com', status: 'rejected', error: 'timeout' },
        ],
      },
    },
  };
}

/** A healthy majority result (2 of 3 fulfilled, unanimous on value). */
function makeHealthyMajority(chain) {
  return {
    chain,
    result: {
      source: 'https://r1.example.com',
      quorum: {
        agreement: 'unanimous',
        mode: 'majority',
        disagreements: [],
        sources: [
          { url: 'https://r1.example.com', status: 'fulfilled', value: '1', normalizedKey: '1' },
          { url: 'https://r2.example.com', status: 'fulfilled', value: '1', normalizedKey: '1' },
          { url: 'https://r3.example.com', status: 'rejected', error: 'timeout' },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// collectDegradationsFromWallets
// ---------------------------------------------------------------------------

describe('collectDegradationsFromWallets', () => {
  it('majority requested, 1/3 fulfilled → one degraded entry', () => {
    const wallet = { results: [makeDegradedQuorum('ethereum')] };
    const out = collectDegradationsFromWallets([wallet], 'majority');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
      chain: 'ethereum',
      requested: 'majority',
      agreement: 'single',
      fulfilledCount: 1,
      totalCount: 3,
    });
  });

  it('majority requested, 2/3 fulfilled → no degradation (threshold met)', () => {
    const wallet = { results: [makeHealthyMajority('ethereum')] };
    const out = collectDegradationsFromWallets([wallet], 'majority');
    assert.equal(out.length, 0);
  });

  it('all requested, 2/3 fulfilled → degraded (all needs unanimity)', () => {
    const wallet = { results: [makeHealthyMajority('ethereum')] };
    const out = collectDegradationsFromWallets([wallet], 'all');
    assert.equal(out.length, 1);
    assert.equal(out[0].requested, 'all');
  });

  it('totalCount <= 1 (single-URL chain) never counts as degraded', () => {
    const wallet = {
      results: [{
        chain: 'solana',
        result: {
          source: 'https://api.mainnet-beta.solana.com',
          quorum: {
            agreement: 'single',
            mode: 'majority',
            disagreements: [],
            sources: [
              { url: 'https://api.mainnet-beta.solana.com', status: 'fulfilled', value: '1', normalizedKey: '1' },
            ],
          },
        },
      }],
    };
    const out = collectDegradationsFromWallets([wallet], 'majority');
    assert.equal(out.length, 0);
  });

  it('two wallets same chain both degraded → dedup to one entry', () => {
    const walletA = { results: [makeDegradedQuorum('ethereum')] };
    const walletB = { results: [makeDegradedQuorum('ethereum')] };
    const out = collectDegradationsFromWallets([walletA, walletB], 'majority');
    assert.equal(out.length, 1);
  });

  it('two wallets different chains both degraded → both surface', () => {
    const walletA = { results: [makeDegradedQuorum('ethereum')] };
    const walletB = { results: [makeDegradedQuorum('polygon')] };
    const out = collectDegradationsFromWallets([walletA, walletB], 'majority');
    assert.equal(out.length, 2);
  });

  it('errored result is skipped', () => {
    const wallet = {
      results: [
        { chain: 'ethereum', error: new Error('boom') },
        { chain: 'polygon', result: { error: 'failed' } },
      ],
    };
    const out = collectDegradationsFromWallets([wallet], 'majority');
    assert.equal(out.length, 0);
  });

  it('non-quorum result (rpc-quorum=any path) is skipped', () => {
    const wallet = {
      results: [{
        chain: 'ethereum',
        result: { source: 'https://r1.example.com' /* no quorum block */ },
      }],
    };
    const out = collectDegradationsFromWallets([wallet], 'majority');
    assert.equal(out.length, 0);
  });
});

// ---------------------------------------------------------------------------
// buildDegradationEntry (used by runTx one-shot flow)
// ---------------------------------------------------------------------------

describe('buildDegradationEntry', () => {
  const DEGRADED_QUORUM = {
    agreement: 'single',
    mode: 'majority',
    disagreements: [],
    sources: [
      { url: 'https://r1.example.com', status: 'fulfilled', value: '1', normalizedKey: '1' },
      { url: 'https://r2.example.com', status: 'rejected', error: 'timeout' },
      { url: 'https://r3.example.com', status: 'rejected', error: 'timeout' },
    ],
  };

  it('returns null when requested is any', () => {
    assert.equal(buildDegradationEntry('ethereum', DEGRADED_QUORUM, 'any'), null);
  });

  it('returns null when requested is undefined', () => {
    assert.equal(buildDegradationEntry('ethereum', DEGRADED_QUORUM, undefined), null);
  });

  it('returns null when quorum is missing', () => {
    assert.equal(buildDegradationEntry('ethereum', undefined, 'majority'), null);
  });

  it('returns a record when majority requested and short-fulfilled', () => {
    const out = buildDegradationEntry('ethereum', DEGRADED_QUORUM, 'majority');
    assert.deepEqual(out, {
      chain: 'ethereum',
      requested: 'majority',
      agreement: 'single',
      fulfilledCount: 1,
      totalCount: 3,
    });
  });

  it('returns null when majority requested and threshold met', () => {
    const healthy = {
      agreement: 'unanimous',
      mode: 'majority',
      disagreements: [],
      sources: [
        { url: 'https://r1.example.com', status: 'fulfilled', value: '1', normalizedKey: '1' },
        { url: 'https://r2.example.com', status: 'fulfilled', value: '1', normalizedKey: '1' },
        { url: 'https://r3.example.com', status: 'rejected', error: 'timeout' },
      ],
    };
    assert.equal(buildDegradationEntry('ethereum', healthy, 'majority'), null);
  });
});

// ---------------------------------------------------------------------------
// formatDegradationWarning
// ---------------------------------------------------------------------------

describe('formatDegradationWarning', () => {
  it('includes chain, "quorum degraded", "majority requested", and 1/3 ratio', () => {
    const msg = formatDegradationWarning({
      chain: 'ethereum',
      requested: 'majority',
      agreement: 'single',
      fulfilledCount: 1,
      totalCount: 3,
    });
    assert.ok(msg.includes('ethereum'), 'chain name present');
    assert.ok(msg.includes('quorum degraded'), 'degradation phrase present');
    assert.ok(msg.includes('majority requested'), 'policy mention present');
    assert.ok(msg.includes('1/3'), 'ratio present');
    assert.ok(msg.includes('meta.sources.rpc.degraded'), 'pointer to schema present');
  });

  it('formats an "all" request likewise', () => {
    const msg = formatDegradationWarning({
      chain: 'polygon',
      requested: 'all',
      agreement: 'single',
      fulfilledCount: 2,
      totalCount: 3,
    });
    assert.ok(msg.includes('all requested'));
    assert.ok(msg.includes('2/3'));
  });
});

// ---------------------------------------------------------------------------
// maybeEmitDegradationWarnings
// ---------------------------------------------------------------------------

/** Capture all writes to process.stderr during fn(); restore on exit. */
function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  try { fn(); } finally { process.stderr.write = original; }
  return chunks;
}

const ONE_DEGRADED = [{
  chain: 'ethereum',
  requested: 'majority',
  agreement: 'single',
  fulfilledCount: 1,
  totalCount: 3,
}];

describe('maybeEmitDegradationWarnings', () => {
  it('opts.json: true → emits nothing', () => {
    const orig = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const chunks = captureStderr(() =>
        maybeEmitDegradationWarnings(ONE_DEGRADED, 'balance', { json: true, ndjson: false }),
      );
      assert.equal(chunks.length, 0);
    } finally { process.stderr.isTTY = orig; }
  });

  it('opts.ndjson: true → emits nothing', () => {
    const orig = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const chunks = captureStderr(() =>
        maybeEmitDegradationWarnings(ONE_DEGRADED, 'balance', { json: false, ndjson: true }),
      );
      assert.equal(chunks.length, 0);
    } finally { process.stderr.isTTY = orig; }
  });

  it('stderr.isTTY false → emits nothing', () => {
    const orig = process.stderr.isTTY;
    process.stderr.isTTY = false;
    try {
      const chunks = captureStderr(() =>
        maybeEmitDegradationWarnings(ONE_DEGRADED, 'balance', { json: false, ndjson: false }),
      );
      assert.equal(chunks.length, 0);
    } finally { process.stderr.isTTY = orig; }
  });

  it('TTY=true and not structured → writes exactly one line with the warning', () => {
    const orig = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const chunks = captureStderr(() =>
        maybeEmitDegradationWarnings(ONE_DEGRADED, 'balance', { json: false, ndjson: false }),
      );
      assert.equal(chunks.length, 1);
      const line = chunks[0];
      assert.ok(line.endsWith('\n'), 'newline-terminated');
      assert.ok(line.includes('quorum degraded'));
      assert.ok(line.includes('majority requested'));
      assert.ok(line.includes('1/3'));
    } finally { process.stderr.isTTY = orig; }
  });

  it('undefined / empty list → emits nothing', () => {
    const orig = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      assert.equal(
        captureStderr(() =>
          maybeEmitDegradationWarnings(undefined, 'balance', { json: false, ndjson: false }),
        ).length,
        0,
      );
      assert.equal(
        captureStderr(() =>
          maybeEmitDegradationWarnings([], 'balance', { json: false, ndjson: false }),
        ).length,
        0,
      );
    } finally { process.stderr.isTTY = orig; }
  });
});
