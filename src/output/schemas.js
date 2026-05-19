/**
 * src/output/schemas.js
 *
 * Stable schema identifiers for every JSON / NDJSON document emitted by glnc.
 * Bump the trailing version (`/v1` -> `/v2`) only on breaking changes; new
 * optional fields are additive within a version.
 *
 * @see README.md "JSON / NDJSON pipeline" for the documented payload shape of
 * each schema id.
 */

export const SCHEMA = Object.freeze({
  BALANCE:        'glnc.balance/v1',
  BALANCE_WATCH:  'glnc.balance.watch/v1',
  TX:             'glnc.tx/v1',
  GAS:            'glnc.gas/v1',
  GAS_WATCH:      'glnc.gas.watch/v1',
  ALERT:          'glnc.alert/v1',
  HISTORY:        'glnc.history/v1',
});

export const ALL_SCHEMAS = Object.freeze(Object.values(SCHEMA));

/**
 * @typedef {{
 *   ok: boolean,
 *   provider?: string,
 *   source?: 'uniswap' | 'cache' | 'hardcoded',
 *   cacheAgeSec?: number,
 *   stale?: boolean,
 *   rateLimited?: boolean,
 *   fallback?: boolean,
 *   chainsFailed?: string[],
 *   unpriced?: string[],
 * }} SourceMeta
 */

/**
 * @typedef {{
 *   sources?: { rpc?: SourceMeta, prices?: SourceMeta, tokenList?: SourceMeta },
 *   partial?: boolean,
 *   warnings?: string[],
 * }} EnvelopeMeta
 */

/**
 * @typedef {{
 *   schema: string,
 *   ts: string,
 *   ok: boolean,
 *   data?: any,
 *   event?: string,
 *   error?: { code: string, message: string } | null,
 *   meta?: EnvelopeMeta,
 * }} Envelope
 */
