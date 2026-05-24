/**
 * test/index.txRawRedaction.test.js
 *
 * Regression test for the credential-leak fix in the `tx --raw` path:
 * URLs emitted under glnc.tx-raw/v1 must be redacted at the output boundary
 * just like the non-raw `glnc.tx/v1` path. Covers `source`, `quorum.sources[].url`,
 * and `quorum.disagreements[].url`.
 *
 * Exercises the internal `redactQuorumUrls` helper directly (exported from
 * src/index.js under the @internal test-only block) and the shared `redactUrl`.
 *
 * Uses node:test + node:assert/strict — no external deps, no real RPCs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { redactQuorumUrls } from '../src/index.js';
import { redactUrl } from '../src/output/serialize.js';

// Credentialed URL used across cases. Host + path must survive; credentials and
// query token must not.
const CRED_URL = 'https://user:secret@rpc.example.com/path?token=abc';

// ---------------------------------------------------------------------------
// redactUrl — sanity check for the source-redaction path used in the raw branch
// ---------------------------------------------------------------------------

describe('redactUrl applied to tx-raw source', () => {
  it('strips username, password, and query string while preserving host', () => {
    const out = redactUrl(CRED_URL);
    assert.ok(out.includes('rpc.example.com'), 'hostname must be preserved');
    assert.ok(!out.includes('user'),     'username must be redacted');
    assert.ok(!out.includes('secret'),   'password must be redacted');
    assert.ok(!out.includes('token=abc'),'query token must be redacted');
  });
});

// ---------------------------------------------------------------------------
// redactQuorumUrls — redacts sources[].url and disagreements[].url in place
// ---------------------------------------------------------------------------

describe('redactQuorumUrls', () => {
  const QUORUM = {
    agreement: 'majority',
    sources: [
      { url: CRED_URL,                                          status: 'fulfilled', value: '0x1' },
      { url: 'https://alice:hunter2@rpc2.example.com/?k=zzz',   status: 'fulfilled', value: '0x1' },
      { url: 'https://r3.example.com/',                         status: 'rejected',  error: 'boom' },
    ],
    disagreements: [
      { url: 'https://bob:topsecret@rpc4.example.com/?api=qqq', value: '0x2' },
    ],
  };

  it('redacts credentials and query strings in sources[].url', () => {
    const out = redactQuorumUrls(QUORUM);
    const joined = JSON.stringify(out.sources);
    assert.ok(!joined.includes('user'),    'sources must not contain user');
    assert.ok(!joined.includes('secret'),  'sources must not contain secret');
    assert.ok(!joined.includes('hunter2'), 'sources must not contain hunter2');
    assert.ok(!joined.includes('token=abc'), 'sources must not contain token=abc');
    assert.ok(!joined.includes('k=zzz'),   'sources must not contain k=zzz');
    assert.ok(joined.includes('rpc.example.com'),  'sources host must be preserved');
    assert.ok(joined.includes('rpc2.example.com'), 'sources host must be preserved');
    assert.ok(joined.includes('r3.example.com'),   'clean URL host must be preserved');
  });

  it('redacts credentials and query strings in disagreements[].url', () => {
    const out = redactQuorumUrls(QUORUM);
    const joined = JSON.stringify(out.disagreements);
    assert.ok(!joined.includes('bob'),       'disagreements must not contain bob');
    assert.ok(!joined.includes('topsecret'), 'disagreements must not contain topsecret');
    assert.ok(!joined.includes('api=qqq'),   'disagreements must not contain api=qqq');
    assert.ok(joined.includes('rpc4.example.com'), 'disagreements host must be preserved');
  });

  it('preserves non-url fields on sources entries (status, value, error)', () => {
    const out = redactQuorumUrls(QUORUM);
    assert.equal(out.sources[0].status, 'fulfilled');
    assert.equal(out.sources[0].value,  '0x1');
    assert.equal(out.sources[2].status, 'rejected');
    assert.equal(out.sources[2].error,  'boom');
  });

  it('preserves agreement field verbatim', () => {
    const out = redactQuorumUrls(QUORUM);
    assert.equal(out.agreement, 'majority');
  });

  it('does not mutate the input quorum object', () => {
    const before = JSON.parse(JSON.stringify(QUORUM));
    redactQuorumUrls(QUORUM);
    assert.deepEqual(QUORUM, before, 'input must be unchanged');
  });

  it('handles missing sources/disagreements arrays without throwing', () => {
    assert.doesNotThrow(() => redactQuorumUrls({ agreement: 'single' }));
    const out = redactQuorumUrls({ agreement: 'single' });
    assert.equal(out.agreement, 'single');
  });

  it('returns input unchanged for null / non-object', () => {
    assert.equal(redactQuorumUrls(null), null);
    assert.equal(redactQuorumUrls(undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// Full-shape simulation — emulate the rest object the raw short-circuit emits
// ---------------------------------------------------------------------------

describe('tx-raw envelope shape with redaction applied', () => {
  it('emitted rest contains no credentials in source or quorum URLs', () => {
    // Shape mirrors what `runTx`'s raw branch builds from the decoder result.
    const rest = {
      chain: 'ethereum',
      hash:  '0x' + 'a'.repeat(64),
      raw:   { tx: { hash: '0xaaa' }, receipt: { status: 'success' } },
      error: null,
      source: CRED_URL,
      blockNumber: '12345',
      quorum: {
        agreement: 'majority',
        sources: [
          { url: CRED_URL,                                        status: 'fulfilled', value: '0x1' },
          { url: 'https://r2.example.com/',                       status: 'fulfilled', value: '0x1' },
          { url: 'https://eve:badpw@rpc3.example.com/?key=leak',  status: 'fulfilled', value: '0x2' },
        ],
        disagreements: [
          { url: 'https://eve:badpw@rpc3.example.com/?key=leak',  value: '0x2' },
        ],
      },
    };
    // Apply the same two operations the raw branch in runTx performs.
    rest.source = redactUrl(rest.source);
    rest.quorum = redactQuorumUrls(rest.quorum);

    const blob = JSON.stringify(rest);
    assert.ok(!blob.includes('user'),     'envelope must not contain user');
    assert.ok(!blob.includes('secret'),   'envelope must not contain secret');
    assert.ok(!blob.includes('token=abc'),'envelope must not contain token=abc');
    assert.ok(!blob.includes('eve'),      'envelope must not contain eve');
    assert.ok(!blob.includes('badpw'),    'envelope must not contain badpw');
    assert.ok(!blob.includes('key=leak'), 'envelope must not contain key=leak');
    assert.ok(blob.includes('rpc.example.com'),  'envelope must preserve rpc.example.com');
    assert.ok(blob.includes('rpc3.example.com'), 'envelope must preserve rpc3.example.com');
  });
});
