/**
 * src/alert/state.js
 *
 * Persist alert "last fired" state to ~/.glnc/alerts.json.
 * Schema: { [alertKey]: { lastFiredAt: number, lastConditionResult: boolean } }
 * alertKey format: `${addressLower}:${conditionString}`
 *
 * Mirrors src/snapshots.js exactly — uses Bun.file/Bun.write + mkdir.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const ALERTS_PATH = `${process.env.HOME}/.glnc/alerts.json`;

/**
 * Read raw alerts file; returns {} on any error.
 *
 * @returns {Promise<Record<string, any>>}
 */
async function readRaw() {
  try {
    const text = await readFile(ALERTS_PATH, 'utf8');
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Write object to alerts file. Never throws.
 *
 * @param {Record<string, any>} data
 * @returns {Promise<void>}
 */
async function writeRaw(data) {
  try {
    await mkdir(dirname(ALERTS_PATH), { recursive: true });
    await writeFile(ALERTS_PATH, JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal — silently ignore write failures
  }
}

/**
 * @typedef {{ lastFiredAt: number, lastConditionResult: boolean }} AlertState
 */

/**
 * Read state for a single alert key.
 *
 * @param {string} alertKey
 * @returns {Promise<AlertState | null>}
 */
export async function readAlertState(alertKey) {
  try {
    const raw = await readRaw();
    const entry = raw[alertKey];
    if (!entry || typeof entry !== 'object') return null;
    return {
      lastFiredAt: entry.lastFiredAt ?? 0,
      lastConditionResult: entry.lastConditionResult ?? false,
    };
  } catch {
    return null;
  }
}

/**
 * Write state for a single alert key, merging with the existing file.
 *
 * @param {string} alertKey
 * @param {AlertState} state
 * @returns {Promise<void>}
 */
export async function writeAlertState(alertKey, { lastFiredAt, lastConditionResult }) {
  try {
    const raw = await readRaw();
    raw[alertKey] = { lastFiredAt, lastConditionResult };
    await writeRaw(raw);
  } catch {
    // Non-fatal
  }
}
