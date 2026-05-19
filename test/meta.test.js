/**
 * test/meta.test.js
 *
 * Coverage for the v1.0.8 source/freshness meta helpers:
 *   - mergePricesMeta       (src/prices.js)
 *   - mergeTokenListMetas   (src/tokens/index.js)
 *
 * Pure-function tests — no network, no side effects.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mergePricesMeta } from '../src/prices.js';
import { mergeTokenListMetas } from '../src/tokens/index.js';

// ---------------------------------------------------------------------------
// mergePricesMeta
// ---------------------------------------------------------------------------

describe('mergePricesMeta', () => {
  it('returns a fresh-success block when given no inputs', () => {
    const m = mergePricesMeta();
    assert.equal(m.ok, true);
    assert.equal(m.provider, 'coingecko');
    assert.equal(m.cacheAgeSec, 0);
    assert.equal(m.stale, false);
    assert.equal(m.rateLimited, false);
    assert.deepEqual(m.unpriced, []);
  });

  it('ignores null/undefined inputs without crashing', () => {
    const m = mergePricesMeta(null, undefined, null);
    assert.equal(m.ok, true);
    assert.equal(m.cacheAgeSec, 0);
  });

  it('ANDs ok across inputs (any failure → not ok)', () => {
    const a = { ok: true,  cacheAgeSec: 0,  stale: false, rateLimited: false, unpriced: [] };
    const b = { ok: false, cacheAgeSec: 0,  stale: false, rateLimited: false, unpriced: [] };
    assert.equal(mergePricesMeta(a, b).ok, false);
    assert.equal(mergePricesMeta(a, a).ok, true);
  });

  it('ORs rateLimited and stale across inputs', () => {
    const a = { ok: true, cacheAgeSec: 0, stale: false, rateLimited: false, unpriced: [] };
    const b = { ok: true, cacheAgeSec: 0, stale: true,  rateLimited: true,  unpriced: [] };
    const merged = mergePricesMeta(a, b);
    assert.equal(merged.rateLimited, true);
    assert.equal(merged.stale, true);
  });

  it('takes MAX cacheAgeSec across inputs', () => {
    const a = { ok: true, cacheAgeSec: 5,  stale: false, rateLimited: false, unpriced: [] };
    const b = { ok: true, cacheAgeSec: 42, stale: false, rateLimited: false, unpriced: [] };
    const c = { ok: true, cacheAgeSec: 12, stale: false, rateLimited: false, unpriced: [] };
    assert.equal(mergePricesMeta(a, b, c).cacheAgeSec, 42);
  });

  it('de-duplicates unpriced symbols across inputs', () => {
    const a = { ok: true, cacheAgeSec: 0, stale: false, rateLimited: false, unpriced: ['ETH', 'XYZ'] };
    const b = { ok: true, cacheAgeSec: 0, stale: false, rateLimited: false, unpriced: ['XYZ', '0xabc'] };
    const merged = mergePricesMeta(a, b);
    assert.deepEqual([...merged.unpriced].sort(), ['0xabc', 'ETH', 'XYZ'].sort());
  });
});

// ---------------------------------------------------------------------------
// mergeTokenListMetas
// ---------------------------------------------------------------------------

describe('mergeTokenListMetas', () => {
  it('empty/null inputs → ok:true with default uniswap source', () => {
    const m = mergeTokenListMetas();
    assert.equal(m.ok, true);
    assert.equal(m.fallback, false);
    assert.equal(m.cacheAgeSec, 0);
  });

  it('a single fallback among many flips source to "hardcoded"', () => {
    const a = { source: 'uniswap',    cacheAgeSec: 0,    fallback: false, ok: true };
    const b = { source: 'cache',      cacheAgeSec: 3600, fallback: false, ok: true };
    const c = { source: 'hardcoded',  cacheAgeSec: 0,    fallback: true,  ok: false };
    const merged = mergeTokenListMetas(a, b, c);
    assert.equal(merged.source, 'hardcoded');
    assert.equal(merged.fallback, true);
    assert.equal(merged.ok, false);
  });

  it('all cache hits → source "cache", uniswap+cache mix → "cache"', () => {
    const a = { source: 'uniswap', cacheAgeSec: 0,    fallback: false, ok: true };
    const b = { source: 'cache',   cacheAgeSec: 1234, fallback: false, ok: true };
    assert.equal(mergeTokenListMetas(a, b).source, 'cache');
  });

  it('takes MAX cacheAgeSec across inputs', () => {
    const a = { source: 'cache', cacheAgeSec: 60,   fallback: false, ok: true };
    const b = { source: 'cache', cacheAgeSec: 3600, fallback: false, ok: true };
    assert.equal(mergeTokenListMetas(a, b).cacheAgeSec, 3600);
  });
});
