/**
 * test/bitcoin.signature.test.js
 *
 * Regression: bitcoin.getBalances must accept the object-arg signature
 * ({ address }) like the EVM/Solana adapters. The positional form
 * stringified `{address: ...}` into the URL as "[object Object]".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getBalances } from '../src/chains/bitcoin.js';

describe('bitcoin.getBalances signature', () => {
  it('accepts { address } and templates the address into the URL', async () => {
    const captured = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      captured.push(String(url));
      const body = JSON.stringify({
        chain_stats:   { funded_txo_sum: 100000000, spent_txo_sum: 0 },
        mempool_stats: { funded_txo_sum: 0,         spent_txo_sum: 0 },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const result = await getBalances({ address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' });

      assert.equal(result.chain, 'bitcoin');
      assert.equal(result.error, null);
      assert.equal(result.native.symbol, 'BTC');
      assert.equal(result.native.amount, '1.00000000');
      assert.equal(result.native.decimals, 8);

      assert.equal(captured.length, 1);
      assert.ok(
        captured[0].includes('/address/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'),
        `expected URL to contain the address, got: ${captured[0]}`,
      );
      assert.ok(
        !captured[0].includes('[object Object]'),
        `URL must not contain "[object Object]", got: ${captured[0]}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
