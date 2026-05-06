/**
 * src/snapshots.js
 *
 * Snapshot persistence for watch-mode deltas.
 *
 * Storage: ~/.glnc/snapshots.json
 * Schema:  { [addressLower]: { [chain]: { [SYMBOL]: { amount: string, timestamp: number } } } }
 *
 * Keys used by the public API:
 *   Map key format: 'chain:SYMBOL'  (e.g. 'ethereum:ETH', 'polygon:USDC')
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SNAPSHOT_PATH = `${process.env.HOME}/.glnc/snapshots.json`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read the raw snapshots file, returning a parsed object or {} on any error.
 *
 * @returns {Promise<Record<string, any>>}
 */
async function readRaw() {
  try {
    const text = await readFile(SNAPSHOT_PATH, 'utf8');
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Write the given object to the snapshot file. Creates the directory if
 * needed. Never throws.
 *
 * @param {Record<string, any>} data
 * @returns {Promise<void>}
 */
async function writeRaw(data) {
  try {
    await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
    await writeFile(SNAPSHOT_PATH, JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal — silently ignore write failures
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the snapshot for a single address.
 *
 * @param {string} address
 * @returns {Promise<Map<string, { amount: string, timestamp: number }> | null>}
 *   Map keyed by 'chain:SYMBOL', or null if no snapshot exists for this address.
 */
export async function readSnapshot(address) {
  try {
    const raw = await readRaw();
    const key = address.toLowerCase();
    const addrData = raw[key];
    if (!addrData || typeof addrData !== 'object') return null;

    const map = new Map();
    for (const [chain, tokens] of Object.entries(addrData)) {
      if (!tokens || typeof tokens !== 'object') continue;
      for (const [symbol, entry] of Object.entries(tokens)) {
        if (!entry || typeof entry.amount !== 'string') continue;
        map.set(`${chain}:${symbol}`, {
          amount: entry.amount,
          timestamp: entry.timestamp ?? 0,
        });
      }
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

/**
 * Write a new snapshot for a single address, merging with existing file data.
 *
 * @param {string} address
 * @param {Array<{ chain: string, result: any, error: any }>} results
 *   The settled chain results array from fetchBalances.
 * @returns {Promise<void>}
 */
export async function writeSnapshot(address, results) {
  try {
    const raw = await readRaw();
    const key = address.toLowerCase();
    const addrData = raw[key] ?? {};
    const now = Date.now();

    for (const { chain, result, error } of results) {
      if (error || !result || result.error) continue;

      const chainData = addrData[chain] ?? {};

      // Native asset
      if (result.native?.symbol && result.native?.amount != null) {
        const sym = result.native.symbol.toUpperCase();
        chainData[sym] = {
          amount: String(result.native.amount),
          timestamp: now,
        };
      }

      // ERC-20 / SPL tokens
      for (const token of result.tokens ?? []) {
        if (!token.symbol || token.amount == null) continue;
        const sym = token.symbol.toUpperCase();
        chainData[sym] = {
          amount: String(token.amount),
          timestamp: now,
        };
      }

      addrData[chain] = chainData;
    }

    raw[key] = addrData;
    await writeRaw(raw);
  } catch {
    // Non-fatal
  }
}
