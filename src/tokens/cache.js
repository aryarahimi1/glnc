/**
 * src/tokens/cache.js
 *
 * Disk cache for the Uniswap token list JSON.
 * Stores in ~/.glnc/token-cache.json using node:fs/promises.
 *
 * Exports:
 *   readCache()        => Promise<{ tokens: object[], fetchedAt: number } | null>
 *   writeCache(data)   => Promise<void>
 *
 * Both functions are always safe to call — they NEVER throw.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR    = join(homedir(), '.glnc');
const CACHE_FILE   = join(CACHE_DIR, 'token-cache.json');

/**
 * Read the token list from the disk cache.
 *
 * Returns a cache hit object when the file exists and is younger than the TTL.
 * Returns null on any read/parse failure or when the cache is stale.
 *
 * @returns {Promise<{ tokens: object[], fetchedAt: number } | null>}
 */
export async function readCache() {
  try {
    const raw  = await readFile(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);

    // Validate the expected shape
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray(data.tokens) ||
      typeof data.fetchedAt !== 'number'
    ) {
      return null;
    }

    // Reject stale entries
    if (Date.now() - data.fetchedAt > CACHE_TTL_MS) {
      return null;
    }

    return { tokens: data.tokens, fetchedAt: data.fetchedAt };
  } catch {
    // Missing file, unreadable, or malformed JSON — all treated as cache miss
    return null;
  }
}

/**
 * Write the raw Uniswap API response to the disk cache.
 *
 * Silently discards any filesystem errors — a failed cache write is never fatal.
 *
 * @param {{ tokens: object[] } & object} data  - raw Uniswap API response
 * @returns {Promise<void>}
 */
export async function writeCache(data) {
  try {
    const payload = JSON.stringify({
      tokens:    data.tokens ?? [],
      fetchedAt: Date.now(),
    });

    await mkdir(CACHE_DIR, { recursive: true });
    // Atomic write so concurrent invocations don't tear the JSON file.
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, payload);
    await rename(tmp, CACHE_FILE);
  } catch {
    // Silently swallow: disk full, permissions error, etc.
  }
}
