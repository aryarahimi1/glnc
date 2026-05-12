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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const SNAPSHOT_PATH = join(homedir(), '.glnc', 'snapshots.json');

const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

// Single-slot mutex for in-process RMW on the snapshots.json file.
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

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
 * Drop entries older than SNAPSHOT_TTL_MS. Mutates data in-place and returns it.
 *
 * @param {Record<string, any>} data
 * @returns {Record<string, any>}
 */
function pruneStale(data) {
  const cutoff = Date.now() - SNAPSHOT_TTL_MS;
  for (const addrKey of Object.keys(data)) {
    const addrData = data[addrKey];
    if (!addrData || typeof addrData !== 'object') { delete data[addrKey]; continue; }
    for (const chain of Object.keys(addrData)) {
      const tokens = addrData[chain];
      if (!tokens || typeof tokens !== 'object') { delete addrData[chain]; continue; }
      for (const sym of Object.keys(tokens)) {
        const entry = tokens[sym];
        if (!entry || !entry.timestamp || entry.timestamp < cutoff) {
          delete tokens[sym];
        }
      }
      if (Object.keys(tokens).length === 0) delete addrData[chain];
    }
    if (Object.keys(addrData).length === 0) delete data[addrKey];
  }
  return data;
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
    // Atomic write: stage to a per-pid tmp then rename. Concurrent `glnc`
    // invocations across terminals would otherwise race on the JSON file.
    const tmp = `${SNAPSHOT_PATH}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(pruneStale(data), null, 2));
    await rename(tmp, SNAPSHOT_PATH);
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
  return withWriteLock(async () => {
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
  });
}
