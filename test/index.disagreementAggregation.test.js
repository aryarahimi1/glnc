/**
 * test/index.disagreementAggregation.test.js
 *
 * Unit tests for the output serialization helpers in src/output/serialize.js:
 *   - isDisagreement
 *   - buildDisagreementEntry
 *   - jsonSafeQuorum  (via jsonSafeQuorumValue internally)
 *   - redactUrl
 *
 * Uses node:test + node:assert/strict — no external deps, no real RPCs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDisagreement,
  buildDisagreementEntry,
  jsonSafeQuorum,
  redactUrl,
} from '../src/output/serialize.js';

// ---------------------------------------------------------------------------
// isDisagreement
// ---------------------------------------------------------------------------

describe('isDisagreement', () => {
  it('returns false for agreement: single with empty disagreements', () => {
    assert.equal(isDisagreement({ agreement: 'single', disagreements: [] }), false);
  });

  it('returns false for agreement: unanimous with empty disagreements', () => {
    assert.equal(isDisagreement({ agreement: 'unanimous', disagreements: [] }), false);
  });

  it('returns false for agreement: majority with empty disagreements', () => {
    assert.equal(isDisagreement({ agreement: 'majority', disagreements: [] }), false);
  });

  it('returns true when agreement is plurality (even with empty disagreements)', () => {
    assert.equal(isDisagreement({ agreement: 'plurality', disagreements: [] }), true);
  });

  it('returns true when disagreements array is non-empty (regardless of agreement field)', () => {
    assert.equal(
      isDisagreement({ agreement: 'majority', disagreements: [{ url: 'https://rpc.example/', value: 'B' }] }),
      true,
    );
  });

  it('returns true when both plurality AND non-empty disagreements', () => {
    assert.equal(
      isDisagreement({ agreement: 'plurality', disagreements: [{ url: 'https://x.example/', value: 'X' }] }),
      true,
    );
  });

  it('returns false when passed null', () => {
    assert.equal(isDisagreement(null), false);
  });

  it('returns false when passed undefined', () => {
    assert.equal(isDisagreement(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// buildDisagreementEntry
// ---------------------------------------------------------------------------

describe('buildDisagreementEntry', () => {
  // Synthetic quorum result: 3 sources, r1+r2 agree on 'A', r3 dissents with 'B'
  const SYNTHETIC_RESULT = {
    source: 'https://r1.example.com',
    quorum: {
      agreement: 'majority',
      disagreements: [
        { url: 'https://r3.example.com', value: 'B', normalizedKey: 'B' },
      ],
      sources: [
        { url: 'https://r1.example.com', status: 'fulfilled', value: 'A', normalizedKey: 'A' },
        { url: 'https://r2.example.com', status: 'fulfilled', value: 'A', normalizedKey: 'A' },
        { url: 'https://r3.example.com', status: 'fulfilled', value: 'B', normalizedKey: 'B' },
      ],
    },
  };

  it('produces providers[] of length 3 with correct agreed flags', () => {
    const entry = buildDisagreementEntry('ethereum', SYNTHETIC_RESULT);
    assert.ok(entry !== null, 'entry must not be null');
    assert.equal(entry.providers.length, 3);

    const agreed = entry.providers.filter(p => p.agreed === true);
    const dissented = entry.providers.filter(p => p.agreed === false);
    assert.equal(agreed.length, 2, '2 providers agreed');
    assert.equal(dissented.length, 1, '1 provider dissented');
  });

  it('providers[agreed=false] is the dissenting URL (redacted)', () => {
    const entry = buildDisagreementEntry('ethereum', SYNTHETIC_RESULT);
    const dissenter = entry.providers.find(p => p.agreed === false);
    assert.ok(dissenter, 'should find a dissenter');
    // URL should be redacted (no credentials in this case, just normal URL)
    assert.equal(dissenter.url, 'https://r3.example.com/');
  });

  it('picked matches the winning group first member URL and value', () => {
    const entry = buildDisagreementEntry('ethereum', SYNTHETIC_RESULT);
    assert.ok(entry !== null);
    // picked.url should be the redacted source URL
    assert.equal(entry.picked.url, 'https://r1.example.com/');
    assert.equal(entry.picked.value, 'A');
  });

  it('chain field is set correctly', () => {
    const entry = buildDisagreementEntry('ethereum', SYNTHETIC_RESULT);
    assert.equal(entry.chain, 'ethereum');
  });

  it('agreement field is preserved from quorum', () => {
    const entry = buildDisagreementEntry('ethereum', SYNTHETIC_RESULT);
    assert.equal(entry.agreement, 'majority');
  });

  it('picked.url strips credentials from URL with username:password', () => {
    const credentialResult = {
      source: 'https://user:pass@rpc.example/',
      quorum: {
        agreement: 'single',
        disagreements: [],
        sources: [
          { url: 'https://user:pass@rpc.example/', status: 'fulfilled', value: 42n, normalizedKey: '42' },
        ],
      },
    };
    const entry = buildDisagreementEntry('ethereum', credentialResult);
    assert.ok(entry !== null);
    // Credentials must be stripped from the URL
    assert.ok(!entry.picked.url.includes('user'), 'username must be redacted');
    assert.ok(!entry.picked.url.includes('pass'), 'password must be redacted');
    assert.ok(entry.picked.url.includes('rpc.example'), 'hostname must be preserved');
  });

  it('providers[].url strips credentials', () => {
    const credentialResult = {
      source: 'https://user:secret@rpc2.example/',
      quorum: {
        agreement: 'single',
        disagreements: [],
        sources: [
          { url: 'https://user:secret@rpc2.example/', status: 'fulfilled', value: '0xabc', normalizedKey: '0xabc' },
        ],
      },
    };
    const entry = buildDisagreementEntry('polygon', credentialResult);
    assert.ok(entry !== null);
    assert.ok(!entry.providers[0].url.includes('secret'), 'password must be redacted in providers[]');
  });

  it('returns null when no matching source for the picked URL', () => {
    const badResult = {
      source: 'https://missing.example.com',
      quorum: {
        agreement: 'majority',
        disagreements: [],
        sources: [
          { url: 'https://other.example.com', status: 'fulfilled', value: 'X', normalizedKey: 'X' },
        ],
      },
    };
    const entry = buildDisagreementEntry('ethereum', badResult);
    assert.equal(entry, null);
  });
});

// ---------------------------------------------------------------------------
// jsonSafeQuorum
// ---------------------------------------------------------------------------

describe('jsonSafeQuorum', () => {
  it('returns an object with the same agreement field', () => {
    const input = {
      agreement: 'unanimous',
      disagreements: [],
      sources: [
        { url: 'https://r1.example.com', status: 'fulfilled', value: 100n, normalizedKey: '100' },
      ],
    };
    const result = jsonSafeQuorum(input);
    assert.equal(result.agreement, 'unanimous');
  });

  it('converts BigInt value in sources[].value to decimal string', () => {
    const input = {
      agreement: 'single',
      disagreements: [],
      sources: [
        { url: 'https://r1.example.com', status: 'fulfilled', value: 12345n, normalizedKey: '12345' },
      ],
    };
    const result = jsonSafeQuorum(input);
    assert.equal(result.sources[0].value, '12345');
  });

  it('converts BigInt value in disagreements[].value to decimal string', () => {
    const input = {
      agreement: 'majority',
      disagreements: [
        { url: 'https://r3.example.com', value: 99n, normalizedKey: '99' },
      ],
      sources: [
        { url: 'https://r1.example.com', status: 'fulfilled', value: 100n, normalizedKey: '100' },
        { url: 'https://r3.example.com', status: 'fulfilled', value: 99n, normalizedKey: '99' },
      ],
    };
    const result = jsonSafeQuorum(input);
    assert.equal(result.disagreements[0].value, '99');
  });

  it('truncates a long object JSON representation to 256 chars + ellipsis', () => {
    // Build an object whose JSON representation is longer than 256 chars
    const bigObj = {};
    for (let i = 0; i < 50; i++) bigObj[`key${i}`] = `value${i}`;
    const input = {
      agreement: 'single',
      disagreements: [],
      sources: [
        { url: 'https://r1.example.com', status: 'fulfilled', value: bigObj, normalizedKey: 'x' },
      ],
    };
    const result = jsonSafeQuorum(input);
    const serialized = result.sources[0].value;
    assert.ok(typeof serialized === 'string', 'result should be a string');
    // The raw JSON is > 256 chars, so the output should be truncated
    const rawJson = JSON.stringify(bigObj);
    if (rawJson.length > 256) {
      assert.ok(serialized.endsWith('…'), 'truncated value must end with ellipsis');
      // The non-ellipsis portion should be 256 chars
      assert.equal(serialized.length, 257, 'truncated value should be 256 chars + ellipsis character');
    }
  });

  it('returns null for null value in sources', () => {
    const input = {
      agreement: 'single',
      disagreements: [],
      sources: [
        { url: 'https://r1.example.com', status: 'fulfilled', value: null, normalizedKey: 'null' },
      ],
    };
    const result = jsonSafeQuorum(input);
    assert.equal(result.sources[0].value, null);
  });

  it('handles a rejected source (no value field) without crashing', () => {
    const input = {
      agreement: 'single',
      disagreements: [],
      sources: [
        { url: 'https://r2.example.com', status: 'rejected', error: 'connection refused' },
      ],
    };
    // Should not throw
    const result = jsonSafeQuorum(input);
    assert.equal(result.sources[0].status, 'rejected');
    assert.equal(result.sources[0].error, 'connection refused');
  });

  it('handles circular objects without crashing (falls back gracefully)', () => {
    const circ = {};
    circ.self = circ; // circular reference
    const input = {
      agreement: 'single',
      disagreements: [],
      sources: [
        { url: 'https://r1.example.com', status: 'fulfilled', value: circ, normalizedKey: 'x' },
      ],
    };
    // Must not throw
    let result;
    assert.doesNotThrow(() => {
      result = jsonSafeQuorum(input);
    });
    // The circular-object fallback should produce a string (e.g., "[object Object]")
    assert.ok(typeof result.sources[0].value === 'string', 'circular fallback must be a string');
  });

  it('preserves string values verbatim (no conversion)', () => {
    const input = {
      agreement: 'unanimous',
      disagreements: [],
      sources: [
        { url: 'https://r1.example.com', status: 'fulfilled', value: 'hello', normalizedKey: 'hello' },
      ],
    };
    const result = jsonSafeQuorum(input);
    assert.equal(result.sources[0].value, 'hello');
  });

  it('preserves boolean values verbatim', () => {
    const input = {
      agreement: 'unanimous',
      disagreements: [],
      sources: [
        { url: 'https://r1.example.com', status: 'fulfilled', value: true, normalizedKey: 'true' },
      ],
    };
    const result = jsonSafeQuorum(input);
    assert.equal(result.sources[0].value, true);
  });
});

// ---------------------------------------------------------------------------
// redactUrl
// ---------------------------------------------------------------------------

describe('redactUrl', () => {
  it('strips username from URL', () => {
    const result = redactUrl('https://user@rpc.example.com/path');
    assert.ok(!result.includes('user'), 'username must be removed');
    assert.ok(result.includes('rpc.example.com'), 'hostname must be preserved');
  });

  it('strips password from URL', () => {
    const result = redactUrl('https://user:secret@rpc.example.com/');
    assert.ok(!result.includes('secret'), 'password must be removed');
    assert.ok(!result.includes('user'), 'username must be removed');
  });

  it('strips query string from URL', () => {
    const result = redactUrl('https://rpc.example.com/?apiKey=ABCDEF123');
    assert.ok(!result.includes('ABCDEF123'), 'query string must be removed');
    assert.ok(!result.includes('apiKey'), 'query param key must be removed');
    assert.ok(result.includes('rpc.example.com'), 'hostname must be preserved');
  });

  it('strips both credentials and query string together', () => {
    const result = redactUrl('https://user:pass@rpc.example.com/path?token=secret');
    assert.ok(!result.includes('user'), 'username must be removed');
    assert.ok(!result.includes('pass'), 'password must be removed');
    assert.ok(!result.includes('secret'), 'query token must be removed');
  });

  it('returns [invalid-url] for null input', () => {
    assert.equal(redactUrl(null), '[invalid-url]');
  });

  it('returns [invalid-url] for empty string', () => {
    assert.equal(redactUrl(''), '[invalid-url]');
  });

  it('returns [invalid-url] for garbage input', () => {
    assert.equal(redactUrl('not-a-url-at-all!!!'), '[invalid-url]');
  });

  it('preserves a clean URL (no credentials, no query)', () => {
    const clean = 'https://rpc.example.com/';
    const result = redactUrl(clean);
    assert.equal(result, clean);
  });

  it('preserves path component after stripping credentials', () => {
    const result = redactUrl('https://user:pass@rpc.example.com/v1/eth');
    assert.ok(result.includes('/v1/eth'), 'path must be preserved');
  });
});
