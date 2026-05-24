/**
 * test/index.multiWalletDisagreement.test.js
 *
 * Regression test for the per-(chain, dissenters) dedup in
 * collectDisagreementsFromWallets — previously this dedup was keyed by chain
 * alone, which silently dropped wallet B's disagreement when wallet A on the
 * same chain produced one with DIFFERENT dissenting providers.
 *
 * The helper is exported from src/index.js under the @internal test-only block.
 *
 * Uses node:test + node:assert/strict — no external deps, no real RPCs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collectDisagreementsFromWallets } from '../src/index.js';

/**
 * Build a per-chain quorum result with a chosen set of dissenting URLs.
 * The shape mirrors what the adapter quorum layer produces.
 */
function makeQuorumResult(chain, pickedUrl, dissenterUrls) {
  const sources = [
    { url: pickedUrl, status: 'fulfilled', value: 'A', normalizedKey: 'A' },
    ...dissenterUrls.map(url => ({ url, status: 'fulfilled', value: 'B', normalizedKey: 'B' })),
  ];
  return {
    chain,
    result: {
      source: pickedUrl,
      quorum: {
        agreement: 'majority',
        disagreements: dissenterUrls.map(url => ({ url, value: 'B', normalizedKey: 'B' })),
        sources,
      },
    },
  };
}

describe('collectDisagreementsFromWallets', () => {
  it('two wallets, same chain, DIFFERENT dissenters → both entries surface', () => {
    const walletA = {
      results: [makeQuorumResult('ethereum', 'https://r1.example.com', ['https://r3.example.com'])],
    };
    const walletB = {
      results: [makeQuorumResult('ethereum', 'https://r1.example.com', ['https://r4.example.com'])],
    };
    const out = collectDisagreementsFromWallets([walletA, walletB]);
    assert.equal(out.length, 2, 'distinct dissenter sets must produce two entries');
    const dissenters = out.map(e => e.providers.filter(p => p.agreed === false).map(p => p.url).join(','));
    // Both r3 and r4 should appear as dissenters across the two entries
    const joined = dissenters.join('|');
    assert.ok(joined.includes('r3.example.com'), 'wallet A dissenter must surface');
    assert.ok(joined.includes('r4.example.com'), 'wallet B dissenter must surface');
  });

  it('two wallets, same chain, IDENTICAL dissenters → one entry (dedup still works)', () => {
    const walletA = {
      results: [makeQuorumResult('ethereum', 'https://r1.example.com', ['https://r3.example.com'])],
    };
    const walletB = {
      results: [makeQuorumResult('ethereum', 'https://r1.example.com', ['https://r3.example.com'])],
    };
    const out = collectDisagreementsFromWallets([walletA, walletB]);
    assert.equal(out.length, 1, 'identical dissenter sets must collapse to one entry');
  });

  it('dissenter URL order does not affect dedup (sorted before keying)', () => {
    const walletA = {
      results: [makeQuorumResult('ethereum', 'https://r1.example.com',
        ['https://r3.example.com', 'https://r4.example.com'])],
    };
    const walletB = {
      results: [makeQuorumResult('ethereum', 'https://r1.example.com',
        ['https://r4.example.com', 'https://r3.example.com'])],
    };
    const out = collectDisagreementsFromWallets([walletA, walletB]);
    assert.equal(out.length, 1, 'same dissenter set in different order must dedup');
  });

  it('two wallets, DIFFERENT chains, same dissenter URLs → both entries surface', () => {
    const walletA = {
      results: [makeQuorumResult('ethereum', 'https://r1.example.com', ['https://r3.example.com'])],
    };
    const walletB = {
      results: [makeQuorumResult('polygon', 'https://r1.example.com', ['https://r3.example.com'])],
    };
    const out = collectDisagreementsFromWallets([walletA, walletB]);
    assert.equal(out.length, 2, 'different chains must produce separate entries');
    const chains = out.map(e => e.chain).sort();
    assert.deepEqual(chains, ['ethereum', 'polygon']);
  });

  it('result with non-disagreement quorum is ignored', () => {
    const wallet = {
      results: [{
        chain: 'ethereum',
        result: {
          source: 'https://r1.example.com',
          quorum: {
            agreement: 'unanimous',
            disagreements: [],
            sources: [
              { url: 'https://r1.example.com', status: 'fulfilled', value: 'A', normalizedKey: 'A' },
            ],
          },
        },
      }],
    };
    const out = collectDisagreementsFromWallets([wallet]);
    assert.equal(out.length, 0);
  });

  it('result with error is skipped', () => {
    const wallet = {
      results: [
        { chain: 'ethereum', error: new Error('rpc down') },
        { chain: 'polygon', result: { error: 'failed' } },
      ],
    };
    const out = collectDisagreementsFromWallets([wallet]);
    assert.equal(out.length, 0);
  });
});
