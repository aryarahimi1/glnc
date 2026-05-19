/**
 * src/output/envelope.js
 *
 * Builders for the canonical JSON / NDJSON envelope. Every machine-readable
 * line glnc emits goes through one of these wrappers so callers never see
 * shape drift between commands. The envelope is:
 *
 *   { schema, ts, ok, [event], data | error, [meta] }
 *
 * `ts` is set by the wrapper at emit time (UTC ISO-8601). Big-int amounts
 * stay as strings inside `data`; numeric USD values stay as plain numbers.
 *
 * `meta` is optional and additive within a schema version: when supplied it
 * carries `sources` (per-source freshness + rate-limit signal), a top-level
 * `partial` flag, and any `warnings[]`. Consumers that don't know about meta
 * keep working — it's strictly additive.
 */

/**
 * Wrap a successful single-document payload.
 *
 * @param {string} schema  - schema id (e.g. SCHEMA.BALANCE)
 * @param {any}    data
 * @param {object|null} [meta]  - optional meta block; omitted from output when null/undefined
 * @returns {import('./schemas.js').Envelope}
 */
export function wrap(schema, data, meta = null) {
  const env = {
    schema,
    ts: new Date().toISOString(),
    ok: true,
    data,
    error: null,
  };
  if (meta) env.meta = meta;
  return env;
}

/**
 * Wrap an error payload. Preserves any error code attached to err.code.
 *
 * @param {string} schema
 * @param {Error|string} err
 * @param {{ code?: string, extra?: object }} [opts]
 * @returns {import('./schemas.js').Envelope}
 */
export function wrapError(schema, err, opts = {}) {
  const message = err instanceof Error ? err.message : String(err);
  const code = opts.code ?? (err && err.code) ?? 'error';
  return {
    schema,
    ts: new Date().toISOString(),
    ok: false,
    data: null,
    error: { code, message, ...(opts.extra ?? {}) },
  };
}

/**
 * Wrap one event in an NDJSON stream (e.g. one poll of `--watch --json`).
 * `event` distinguishes lines: 'poll' | 'error' | 'stop' | command-specific.
 *
 * @param {string} schema
 * @param {string} event
 * @param {object} fields  - merged into the envelope; `ok` defaults to true
 * @returns {import('./schemas.js').Envelope}
 */
export function wrapEvent(schema, event, fields = {}) {
  const { ok = true, data = null, error = null, meta = null, ...rest } = fields;
  const env = {
    schema,
    ts: new Date().toISOString(),
    ok,
    event,
    data,
    error,
    ...rest,
  };
  if (meta) env.meta = meta;
  return env;
}
