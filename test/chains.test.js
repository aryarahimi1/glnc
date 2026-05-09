/**
 * test/chains.test.js
 *
 * Pure-function tests for src/chains/index.js (detectAddressType, getChainAdapter).
 * No network calls — all tested functions are synchronous.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectAddressType, getChainAdapter, EVM_CHAINS } from '../src/chains/index.js';

describe('detectAddressType', () => {
  it('detects EVM address (checksummed)', () => {
    assert.equal(detectAddressType('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'), 'evm');
  });

  it('detects EVM address (lowercase)', () => {
    assert.equal(detectAddressType('0xd8da6bf26964af9d7eed9e03e53415d37aa96045'), 'evm');
  });

  it('detects Bitcoin bech32 address', () => {
    assert.equal(detectAddressType('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), 'bitcoin');
  });

  it('detects Bitcoin P2PKH address', () => {
    // Canonical genesis-block coinbase address (1A1z...DivfNa with capital N).
    // base58check checksum is verified by the detector, so a typo'd version
    // (e.g. trailing "Divfna" lowercase) would fall through to Solana — that
    // is the intended behavior since Bitcoin pubkey hashes that don't
    // checksum-validate are not real addresses.
    assert.equal(detectAddressType('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), 'bitcoin');
  });

  it('detects Bitcoin P2SH address', () => {
    // Canonical example P2SH address (3...).
    assert.equal(detectAddressType('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), 'bitcoin');
  });

  it('detects Solana address', () => {
    assert.equal(detectAddressType('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'), 'solana');
  });

  it('detects Solana address starting with 1 (would have collided with Bitcoin legacy)', () => {
    // 32-44 char base58 starting with '1' is the exact ambiguity range where
    // pre-base58check detection would misclassify as Bitcoin. Random Solana
    // pubkeys with this shape are common; checksum validation rules them out
    // as Bitcoin and they correctly land on Solana.
    assert.equal(detectAddressType('1nc1nerator11111111111111111111111111111111'), 'solana');
  });

  it('returns unknown for empty string', () => {
    assert.equal(detectAddressType(''), 'unknown');
  });

  it('returns unknown for null', () => {
    assert.equal(detectAddressType(null), 'unknown');
  });

  it('returns unknown for garbage input', () => {
    assert.equal(detectAddressType('not-an-address'), 'unknown');
  });
});

describe('getChainAdapter', () => {
  it('returns adapter for each EVM chain', () => {
    for (const chain of EVM_CHAINS) {
      const adapter = getChainAdapter(chain);
      assert.ok(adapter !== null, `Expected adapter for chain: ${chain}`);
    }
  });

  it('returns null for unknown chain', () => {
    assert.equal(getChainAdapter('nonexistentchain'), null);
  });

  it('is case-insensitive', () => {
    assert.ok(getChainAdapter('Ethereum') !== null);
    assert.ok(getChainAdapter('SOLANA') !== null);
  });
});
