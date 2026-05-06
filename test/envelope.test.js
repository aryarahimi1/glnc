/**
 * test/envelope.test.js
 *
 * Envelope contract tests for src/output/envelope.js, emit.js, and schemas.js.
 * Uses node:test + node:assert/strict — no external deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { wrap, wrapError, wrapEvent } from '../src/output/envelope.js';
import { emitNDJSON } from '../src/output/emit.js';
import { SCHEMA, ALL_SCHEMAS } from '../src/output/schemas.js';

// ---------------------------------------------------------------------------
// wrap
// ---------------------------------------------------------------------------

describe('wrap', () => {
  it('produces {schema, ts, ok:true, data} shape', () => {
    const env = wrap(SCHEMA.BALANCE, { eth: '1.0' });
    assert.equal(env.schema, SCHEMA.BALANCE);
    assert.equal(env.ok, true);
    assert.deepEqual(env.data, { eth: '1.0' });
    assert.ok(typeof env.ts === 'string' && env.ts.length > 0, 'ts should be a non-empty string');
  });

  it('ts is a valid ISO-8601 date string', () => {
    const env = wrap(SCHEMA.GAS, null);
    assert.ok(!Number.isNaN(Date.parse(env.ts)), 'ts must be parseable as a date');
  });

  it('ok is strictly true (not truthy)', () => {
    const env = wrap(SCHEMA.TX, {});
    assert.equal(env.ok, true);
  });
});

// ---------------------------------------------------------------------------
// wrapError
// ---------------------------------------------------------------------------

describe('wrapError', () => {
  it('produces {schema, ts, ok:false, error:{message,code}} shape', () => {
    const env = wrapError(SCHEMA.BALANCE, new Error('rpc down'), { code: 'RPC_FAIL' });
    assert.equal(env.schema, SCHEMA.BALANCE);
    assert.equal(env.ok, false);
    assert.equal(env.error.message, 'rpc down');
    assert.equal(env.error.code, 'RPC_FAIL');
  });

  it('accepts a plain string error message', () => {
    const env = wrapError(SCHEMA.TX, 'timeout');
    assert.equal(env.ok, false);
    assert.equal(env.error.message, 'timeout');
  });

  it('falls back to code "error" when none provided', () => {
    const env = wrapError(SCHEMA.GAS, 'boom');
    assert.equal(env.error.code, 'error');
  });

  it('picks up err.code from an Error object when no opts.code given', () => {
    const err = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    const env = wrapError(SCHEMA.HISTORY, err);
    assert.equal(env.error.code, 'NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// wrapEvent
// ---------------------------------------------------------------------------

describe('wrapEvent', () => {
  it('produces {schema, ts, ok, event, data} shape', () => {
    const env = wrapEvent(SCHEMA.BALANCE_WATCH, 'poll', { data: { eth: '2.0' } });
    assert.equal(env.schema, SCHEMA.BALANCE_WATCH);
    assert.equal(env.event, 'poll');
    assert.equal(env.ok, true);
    assert.deepEqual(env.data, { eth: '2.0' });
  });

  it('propagates ok:false when fields.ok is false', () => {
    const env = wrapEvent(SCHEMA.ALERT, 'error', { ok: false, error: { code: 'E', message: 'm' } });
    assert.equal(env.ok, false);
  });

  it('defaults ok to true when not supplied', () => {
    const env = wrapEvent(SCHEMA.GAS_WATCH, 'poll', {});
    assert.equal(env.ok, true);
  });
});

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------

describe('SCHEMA', () => {
  it('every schema id ends with /v1 (versioned)', () => {
    for (const id of ALL_SCHEMAS) {
      assert.ok(id.endsWith('/v1'), `Schema "${id}" does not end with /v1`);
    }
  });

  it('contains all 7 expected schema keys', () => {
    const keys = Object.keys(SCHEMA);
    assert.equal(keys.length, 7);
  });

  it('ALL_SCHEMAS has same length as SCHEMA', () => {
    assert.equal(ALL_SCHEMAS.length, Object.keys(SCHEMA).length);
  });
});

// ---------------------------------------------------------------------------
// emitNDJSON — one JSON object per line
// ---------------------------------------------------------------------------

describe('emitNDJSON', () => {
  it('writes exactly one compact JSON line to stdout', () => {
    const chunks = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(chunk); return true; };

    try {
      const env = wrap(SCHEMA.TX, { hash: '0xabc' });
      emitNDJSON(env);
    } finally {
      process.stdout.write = original;
    }

    assert.equal(chunks.length, 1);
    const line = chunks[0];
    assert.ok(line.endsWith('\n'), 'output must be newline-terminated');

    // Must be valid JSON and not pretty-printed (no internal newlines)
    const text = line.trimEnd();
    assert.ok(!text.includes('\n'), 'NDJSON must be single-line (no internal newlines)');
    const parsed = JSON.parse(text);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data, { hash: '0xabc' });
  });
});
