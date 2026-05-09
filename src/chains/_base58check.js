/**
 * src/chains/_base58check.js
 *
 * Tiny base58check verifier for Bitcoin legacy P2PKH/P2SH addresses.
 * No external dependency — uses node:crypto's sha256.
 *
 * Used by chain-detection helpers to disambiguate the 32-34 char overlap
 * between Bitcoin legacy addresses (start with '1' or '3') and Solana
 * pubkeys (32-44 base58 chars, can also start with '1' or '3'). Pattern
 * matching alone misclassifies in both directions; checksum validation
 * resolves it deterministically.
 */

import { createHash } from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const BASE58_INDEX = (() => {
  const map = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    map[BASE58_ALPHABET.charCodeAt(i)] = i;
  }
  return map;
})();

/**
 * Decode a base58 string to a byte array. Returns null on invalid input.
 *
 * @param {string} str
 * @returns {Uint8Array | null}
 */
function base58Decode(str) {
  if (typeof str !== 'string' || str.length === 0) return null;

  // Big-endian byte accumulator built up by repeatedly multiplying by 58.
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 128) return null;
    const v = BASE58_INDEX[code];
    if (v < 0) return null;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>>= 8;
    }
  }

  // Each leading '1' represents a leading zero byte.
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    bytes.push(0);
  }

  bytes.reverse();
  return Uint8Array.from(bytes);
}

/**
 * Return true iff `address` is a base58check-valid Bitcoin legacy P2PKH or
 * P2SH mainnet address (25 bytes total, version 0x00 or 0x05, checksum OK).
 *
 * @param {string} address
 * @returns {boolean}
 */
export function isBitcoinLegacyChecksumValid(address) {
  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== 25) return false;
  const version = decoded[0];
  if (version !== 0x00 && version !== 0x05) return false;

  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const h1 = createHash('sha256').update(payload).digest();
  const h2 = createHash('sha256').update(h1).digest();
  for (let i = 0; i < 4; i++) {
    if (h2[i] !== checksum[i]) return false;
  }
  return true;
}
