/**
 * src/resolvers/ens.js
 *
 * ENS name resolution using viem's built-in ENS support.
 *
 * Exports:
 *   resolveAddress(input)        — forward resolution (name or address → address)
 *   reverseResolveAddress(addr)  — reverse resolution (address → name or null)
 *
 * SNS (.sol names) not implemented: public Solana RPC throttles getProgramAccounts.
 * Use Helius free tier (helius.dev) to add SNS support later.
 */

import { createPublicClient, http, isAddress, getAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';

// Use the same RPC URL as ethereum.js
const RPC = 'https://ethereum-rpc.publicnode.com';

/** @type {import('viem').PublicClient | null} */
let _client = null;

/**
 * Lazy singleton viem client pointed at Ethereum mainnet.
 * ENS resolution always uses mainnet regardless of which chain the user
 * is querying balances on.
 *
 * @returns {import('viem').PublicClient}
 */
function getClient() {
  if (_client) return _client;
  _client = createPublicClient({
    chain: mainnet,
    transport: http(RPC, { timeout: 10_000 }),
  });
  return _client;
}

/**
 * Determine whether a string looks like a valid EVM address (0x + 40 hex chars).
 *
 * @param {string} input
 * @returns {boolean}
 */
function isEvmAddress(input) {
  return /^0x[0-9a-fA-F]{40}$/.test(input);
}

/**
 * Determine whether an input looks like an ENS-style name (contains a dot).
 * viem's normalize() handles .eth, .xyz, .dao, and other ENS TLDs.
 *
 * @param {string} input
 * @returns {boolean}
 */
function looksLikeName(input) {
  return typeof input === 'string' && input.includes('.');
}

/**
 * Resolve an ENS name or plain address to a canonical EVM address.
 *
 * - Plain 0x address  → returned immediately (no RPC call)
 * - .eth / ENS name   → resolved via mainnet ENS
 * - Non-EVM address   → returned as-is with type 'address' (Solana, BTC, etc.)
 * - Name not found    → { address: null, error: 'ENS name not found' }
 * - RPC failure       → { address: null, error: err.message }
 *
 * @param {string} input  — raw user input (e.g. 'vitalik.eth', '0xd8dA…', 'unknown.eth')
 * @returns {Promise<{
 *   address: string | null,
 *   displayName: string | null,
 *   type: 'ens' | 'address',
 *   error?: string,
 * }>}
 */
export async function resolveAddress(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return { address: null, displayName: input, type: 'address', error: 'Empty input' };
  }

  // ── Plain EVM address: no resolution needed ───────────────────────────────
  if (isEvmAddress(input)) {
    // Normalize to checksummed form so downstream code can always rely on it.
    try {
      return { address: getAddress(input), displayName: null, type: 'address' };
    } catch {
      return { address: input, displayName: null, type: 'address' };
    }
  }

  // ── Non-EVM, non-name strings (Solana, Bitcoin, etc.) ────────────────────
  // These don't contain a dot and aren't 0x addresses; pass through unchanged.
  if (!looksLikeName(input)) {
    return { address: input, displayName: null, type: 'address' };
  }

  // ── ENS / dot-name resolution ─────────────────────────────────────────────
  try {
    const normalized = normalize(input);
    const address = await getClient().getEnsAddress({ name: normalized });

    if (!address) {
      return {
        address: null,
        displayName: input,
        type: 'ens',
        error: 'ENS name not found',
      };
    }

    return {
      address: getAddress(address), // checksummed
      displayName: input,
      type: 'ens',
    };
  } catch (err) {
    return {
      address: null,
      displayName: input,
      type: 'ens',
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Reverse-resolve an EVM address to its primary ENS name.
 * Returns null if the address has no reverse record or if the RPC call fails.
 * Never throws.
 *
 * @param {string} address  — checksummed or lowercase 0x address
 * @returns {Promise<string | null>}
 */
export async function reverseResolveAddress(address) {
  if (!isEvmAddress(address)) return null;

  try {
    // viem's getEnsName requires a checksummed address
    const checksummed = getAddress(address);
    const name = await getClient().getEnsName({ address: checksummed });
    return name ?? null;
  } catch {
    return null;
  }
}
