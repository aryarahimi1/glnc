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
  // Raw upstream RPC `getTransaction` response, passed through the envelope
  // without glnc-level reshaping. The `data.raw` payload is the original
  // provider response shape and is therefore NOT stable across providers OR
  // across chain types (EVM viem `tx`+`receipt` vs Solana JSON-RPC result).
  // Callers that want a stable cross-chain shape should keep using
  // glnc.tx/v1; this schema exists specifically so callers who need the
  // provider's exact response can get it without glnc lying about it.
  TX_RAW:         'glnc.tx-raw/v1',
  GAS:            'glnc.gas/v1',
  GAS_WATCH:      'glnc.gas.watch/v1',
  ALERT:          'glnc.alert/v1',
  HISTORY:        'glnc.history/v1',
});

/**
 * Freshness + provenance metadata attached by chain adapters to balance and
 * transaction responses so consumers can attribute the data to a specific
 * point in chain history AND to the RPC that ultimately answered. Additive
 * within /v1 — older consumers ignore these fields.
 *
 * Common (all chains, both `balance` per-chain entries and `tx` envelopes):
 *   - source:      string, the URL of the winning RPC provider (matches the
 *                  same chain's entry in `meta.sources.rpc.providers`).
 *
 * EVM (`balance`, `tx`):
 *   - blockNumber: decimal string (viem returns BigInt; stringified at the
 *                  adapter boundary so JSON.stringify never throws). Null on
 *                  the tx side when the tx has not been mined yet.
 *
 * Solana (`balance`):
 *   - slot:       number, the slot at which the native-balance RPC was
 *                 answered. blockTime is intentionally NOT fetched here — it
 *                 would require an extra getBlockTime call per request.
 *
 * Solana (`tx`):
 *   - slot:       number, slot in which the transaction was processed.
 *   - blockTime:  unix seconds, included by getTransaction itself (no extra
 *                 RPC call).
 *
 * @typedef {{ source?: string, blockNumber?: string | null }} EvmFreshness
 * @typedef {{ source?: string, slot?: number | null, blockTime?: number | null }} SolanaFreshness
 */

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
 *   providers?: Record<string, string>,
 *   disagreements?: RpcDisagreement[],
 *   degraded?: RpcDegradation[],
 *   unpriced?: string[],
 * }} SourceMeta
 */

/**
 * Aggregated per-chain RPC quorum disagreement, surfaced on
 * `meta.sources.rpc.disagreements[]` whenever an adapter ran with
 * `--rpc-quorum=majority` and providers diverged. Empty in the common
 * default-mode (`--rpc-quorum=any`) case since first-success-wins cannot
 * produce a disagreement record.
 *
 * Values are JSON-safe: BigInt-typed adapter results are stringified, and
 * object-typed results are bounded to a 256-char JSON preview to keep the
 * envelope manageable.
 *
 * `picked.url` always matches one of the entries in `providers[]` whose
 * `agreed: true` — it identifies the source whose value the orchestrator
 * actually returned to the caller.
 *
 * @typedef {{
 *   chain: string,
 *   agreement: 'unanimous' | 'majority' | 'plurality' | 'single',
 *   providers: Array<{ url: string, value: any, agreed: boolean }>,
 *   picked: { url: string, value: any },
 * }} RpcDisagreement
 */

/**
 * Per-chain record emitted when --rpc-quorum=majority|all was requested but
 * fewer providers responded than required to satisfy the policy. Lets
 * consumers detect silent downgrade to single-provider mode.
 *
 * @typedef {{
 *   chain: string,
 *   requested: 'majority' | 'all',
 *   agreement: 'unanimous' | 'majority' | 'plurality' | 'single',
 *   fulfilledCount: number,
 *   totalCount: number,
 * }} RpcDegradation
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
