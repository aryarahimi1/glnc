/**
 * src/chains/index.js
 *
 * Multi-chain orchestrator.
 *
 * Detects the address type and dispatches to the relevant chain adapters.
 * Each adapter failure is isolated — the returned array always has one entry
 * per chain queried, with `error` set on failure.
 *
 * Exports:
 *   detectAddressType(address)  => 'evm' | 'solana' | 'bitcoin' | 'unknown'
 *   getAllBalances(address)      => Promise<BalanceResult[]>
 *   getChainAdapter(chainName)  => adapter | null
 *   EVM_CHAINS                  — string[] of EVM chain names
 */

import * as ethereum from './ethereum.js';
import * as polygon  from './polygon.js';
import * as arbitrum from './arbitrum.js';
import * as base     from './base.js';
import * as optimism from './optimism.js';
import * as linea    from './linea.js';
import * as zksync   from './zksync.js';
import * as solana   from './solana.js';
import * as bitcoin  from './bitcoin.js';
import { isBitcoinLegacyChecksumValid } from './_base58check.js';
import { isBitcoinBech32Valid } from './_bech32.js';

export const EVM_CHAINS = ['ethereum', 'polygon', 'arbitrum', 'base', 'optimism', 'linea', 'zksync'];

const EVM_ADAPTERS = [ethereum, polygon, arbitrum, base, optimism, linea, zksync];

const ALL_ADAPTERS = {
  ethereum,
  polygon,
  arbitrum,
  base,
  optimism,
  linea,
  zksync,
  solana,
  bitcoin,
};

/**
 * Detect the address type from its format.
 *
 * Rules:
 *   - 0x followed by 40 hex chars → EVM
 *   - Starts with bc1, 1, or 3, length 25–62 → Bitcoin (Bech32 / P2PKH / P2SH)
 *   - Base58-like, 32–44 chars, no 0x prefix → Solana
 *   - Everything else → unknown
 *
 * @param {string} address
 * @returns {'evm' | 'solana' | 'bitcoin' | 'unknown'}
 */
export function detectAddressType(address) {
  if (!address || typeof address !== 'string') return 'unknown';

  const trimmed = address.trim();

  // EVM: 0x + 40 hex chars (case-insensitive)
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return 'evm';

  // Bitcoin Bech32 (native segwit): bc1...
  if (/^bc1[0-9a-z]{6,87}$/i.test(trimmed) && isBitcoinBech32Valid(trimmed)) {
    return 'bitcoin';
  }

  // Bitcoin legacy P2PKH / P2SH (1... / 3...). Uses base58check verification
  // so the 32-34 char overlap with Solana pubkeys is resolved deterministically:
  // a string that doesn't checksum-validate as Bitcoin falls through to Solana.
  if (
    /^[13][1-9A-HJ-NP-Za-km-z]{24,33}$/.test(trimmed) &&
    isBitcoinLegacyChecksumValid(trimmed)
  ) {
    return 'bitcoin';
  }

  // Solana: base58, typically 32-44 chars, no leading 0x.
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return 'solana';

  return 'unknown';
}

/**
 * Query all relevant chains for balances.
 * Never throws — each failed chain returns { chain, error }.
 *
 * @param {string} address
 * @returns {Promise<Array<{
 *   chain: string,
 *   native: { symbol: string, amount: string, decimals: number } | null,
 *   tokens: Array<{ symbol: string, amount: string, decimals: number, contract: string }>,
 *   error: string | null
 * }>>}
 */
export async function getAllBalances(address) {
  const type = detectAddressType(address);

  if (type === 'bitcoin') {
    return [await bitcoin.getBalances(address)];
  }

  if (type === 'solana') {
    return [await solana.getBalances(address)];
  }

  if (type === 'evm') {
    // Query all EVM chains concurrently; isolate failures
    const results = await Promise.allSettled(
      EVM_ADAPTERS.map(adapter => adapter.getBalances(address))
    );
    return results.map((res, i) => {
      if (res.status === 'fulfilled') return res.value;
      return {
        chain:  EVM_ADAPTERS[i].name,
        native: null,
        tokens: [],
        error:  res.reason?.message ?? String(res.reason),
      };
    });
  }

  // Unknown address type
  return [{
    chain:  'unknown',
    native: null,
    tokens: [],
    error:  `Cannot determine chain for address: ${address}`,
  }];
}

/**
 * Look up a single chain adapter by name.
 *
 * @param {string} chainName  - e.g. 'ethereum', 'solana', 'bitcoin'
 * @returns {object | null}
 */
export function getChainAdapter(chainName) {
  return ALL_ADAPTERS[chainName.toLowerCase()] ?? null;
}
