/**
 * test/output.redactUrl.test.js
 *
 * Unit tests for redactUrl in src/output/serialize.js. Covers credential,
 * query-string, and fragment stripping (the fragment case is the regression
 * guard for the `…/#token=secret` smuggling vector).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { redactUrl } from '../src/output/serialize.js';

describe('redactUrl', () => {
  it('strips userinfo, query, and fragment while preserving host and path', () => {
    const out = redactUrl('https://user:pass@host.com/path?q=1#frag');
    assert.ok(!out.includes('user'), `must not contain "user", got: ${out}`);
    assert.ok(!out.includes('pass'), `must not contain "pass", got: ${out}`);
    assert.ok(!out.includes('q=1'), `must not contain "q=1", got: ${out}`);
    assert.ok(!out.includes('frag'), `must not contain "frag", got: ${out}`);
    assert.ok(out.includes('host.com/path'), `must preserve host+path, got: ${out}`);
  });

  it('strips fragment-based secrets (the "#token=secret" smuggling vector)', () => {
    const out = redactUrl('https://host.com/#token=secret');
    assert.ok(!out.includes('token'), `must not leak "token", got: ${out}`);
    assert.ok(!out.includes('secret'), `must not leak "secret", got: ${out}`);
  });

  it('returns "[invalid-url]" for unparseable input (regression guard)', () => {
    assert.equal(redactUrl('not-a-url'), '[invalid-url]');
  });
});
