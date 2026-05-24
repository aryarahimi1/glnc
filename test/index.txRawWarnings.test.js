/**
 * test/index.txRawWarnings.test.js
 *
 * Regression test: `glnc tx <hash> --raw --rpc-quorum=majority` must still
 * surface disagreement warnings to stderr even though --raw forces json=true.
 * Warnings go to stderr (never stdout), so the json-suppression bypass in
 * runTx's raw short-circuit is safe.
 *
 * Stubs the decoder via the @internal __setDecoderForTest seam exported by
 * src/index.js. Captures both stdout (envelope) and stderr (warning) writes.
 *
 * Uses node:test + node:assert/strict — no external deps, no real RPCs.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runTx, __setDecoderForTest } from '../src/index.js';

// ---------------------------------------------------------------------------
// I/O capture helpers
// ---------------------------------------------------------------------------

function captureStreams(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(typeof chunk === 'string' ? chunk : chunk.toString()); return true; };
  process.stderr.write = (chunk) => { err.push(typeof chunk === 'string' ? chunk : chunk.toString()); return true; };
  return Promise.resolve(fn())
    .finally(() => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    })
    .then(() => ({ out, err }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const VALID_EVM_HASH = '0x' + 'a'.repeat(64);

describe('runTx --raw with quorum disagreement', () => {
  let origIsTTY;

  beforeEach(() => {
    origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
  });

  afterEach(() => {
    process.stderr.isTTY = origIsTTY;
    __setDecoderForTest(null);
  });

  it('emits a disagreement warning to stderr even when --raw forces json=true', async () => {
    // Stub decoder returns a TX_RAW envelope whose quorum represents disagreement.
    __setDecoderForTest({
      decodeTransaction: async (chain, hash, opts) => {
        assert.equal(opts.raw, true, 'decoder must be invoked with raw=true');
        return {
          __schema: 'glnc.tx-raw/v1',
          chain,
          hash,
          source: 'https://r1.example.com',
          quorum: {
            agreement: 'majority',
            disagreements: [
              { url: 'https://r3.example.com', value: '0xdef', normalizedKey: '0xdef' },
            ],
            sources: [
              { url: 'https://r1.example.com', status: 'fulfilled', value: '0xabc', normalizedKey: '0xabc' },
              { url: 'https://r2.example.com', status: 'fulfilled', value: '0xabc', normalizedKey: '0xabc' },
              { url: 'https://r3.example.com', status: 'fulfilled', value: '0xdef', normalizedKey: '0xdef' },
            ],
          },
          raw: { tx: { hash: VALID_EVM_HASH } },
        };
      },
    });

    const { out, err } = await captureStreams(() =>
      runTx(VALID_EVM_HASH, 'ethereum', { json: true, raw: true, rpcQuorum: 'majority' }),
    );

    // ── stderr: must contain a transaction-disagreement warning ──
    const stderrJoined = err.join('');
    assert.ok(stderrJoined.length > 0, 'stderr must receive at least one write');
    assert.ok(stderrJoined.includes('transaction disagreement'),
      `stderr must include "transaction disagreement": ${stderrJoined}`);
    assert.ok(stderrJoined.includes('ethereum'),
      `stderr warning must mention the chain: ${stderrJoined}`);

    // ── stdout: must be a clean glnc.tx-raw/v1 envelope, no warning text ──
    const stdoutJoined = out.join('');
    assert.ok(stdoutJoined.length > 0, 'stdout must receive an envelope');
    assert.ok(!stdoutJoined.includes('transaction disagreement'),
      'stdout must NOT contain the warning text');
    assert.ok(!stdoutJoined.includes('!'),
      'stdout must not leak the warning sigil');

    // Parse the envelope — must be valid JSON of schema glnc.tx-raw/v1.
    const parsed = JSON.parse(stdoutJoined);
    assert.equal(parsed.schema, 'glnc.tx-raw/v1', 'envelope schema must be tx-raw/v1');
  });

  it('does NOT emit a warning when quorum has no disagreement', async () => {
    __setDecoderForTest({
      decodeTransaction: async (chain, hash) => ({
        __schema: 'glnc.tx-raw/v1',
        chain,
        hash,
        source: 'https://r1.example.com',
        quorum: {
          agreement: 'unanimous',
          disagreements: [],
          sources: [
            { url: 'https://r1.example.com', status: 'fulfilled', value: '0xabc', normalizedKey: '0xabc' },
            { url: 'https://r2.example.com', status: 'fulfilled', value: '0xabc', normalizedKey: '0xabc' },
          ],
        },
        raw: { tx: { hash: VALID_EVM_HASH } },
      }),
    });

    const { err } = await captureStreams(() =>
      runTx(VALID_EVM_HASH, 'ethereum', { json: true, raw: true, rpcQuorum: 'majority' }),
    );

    const stderrJoined = err.join('');
    assert.ok(!stderrJoined.includes('transaction disagreement'),
      `no warning expected when quorum agrees: got ${stderrJoined}`);
  });
});
