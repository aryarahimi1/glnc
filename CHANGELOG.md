# Changelog

All notable changes to glnc are documented in this file. The format roughly
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-05-22 — "Honest multi-RPC"

This release moves glnc from "one vendor's response, presented as truth" to
"multiple vendors queried in parallel, with disagreement surfaced explicitly."
Detection is opt-in via `--rpc-quorum=majority` or `all`; the default
behavior keeps free-tier RPCs from being triple-loaded for every casual query.

### Added

- `RPC_URLS[]` arrays per EVM adapter (ethereum, polygon, arbitrum, base,
  optimism, linea each ship 3 URLs; zksync and solana ship 2). The Solana
  helper was rewritten to match the new contract.
- `--rpc-quorum <any|majority|all>` flag on `balance` and `tx`:
  - `any` (default) — sequential first-success, no parallel fan-out, no
    disagreement detection.
  - `majority` — parallel, plurality winner, dissent recorded in
    `meta.sources.rpc.disagreements[]`.
  - `all` — parallel, unanimous required, throws on disagreement.
- `meta.sources.rpc.providers` — map of chain to redacted winning URL. Lets
  consumers see which vendor served each number.
- `meta.sources.rpc.disagreements[]` — per-chain disagreement records with
  `{ chain, agreement, providers[], picked }`. Empty in `--rpc-quorum=any`;
  populated under `majority`/`all` when providers diverged.
- Per-chain freshness metadata on each `data.wallets[].chains[]` entry:
  `source` (redacted RPC URL), `blockNumber` (EVM) or `slot` (Solana), and
  `quorum` (when `--rpc-quorum !== 'any'`).
- The same `source` / `blockNumber` / `slot` / `blockTime` / `quorum` fields
  on the top-level `glnc.tx/v1` envelope.
- `--raw` flag on `tx`: emits the upstream RPC `getTransaction` response
  verbatim under the new `glnc.tx-raw/v1` schema. Provider-native shape —
  not stable across providers or chains. Solana raw payload preserves the
  original `signatures[]` array; EVM raw payload is viem's `{ tx, receipt }`
  with BigInts stringified at the JSON boundary. Implies `--json`.
- `glnc.tx-raw/v1` schema in `src/output/schemas.js` and `glnc schema`.
- Stderr disagreement warnings: when stderr is an interactive TTY and a
  disagreement is detected, glnc emits one line per chain
  (`! ethereum: balance disagreement (...) — using majority`). Suppressed
  under `--json` / `--ndjson` and when stderr is piped/redirected. Not
  emitted during `--watch` — the per-poll envelope still records
  `meta.sources.rpc.disagreements[]`; the warning is just a one-shot UX
  cue. `--raw` is the exception: warnings still fire on stderr even
  though `--raw` forces `--json` (stderr is a separate channel and
  doesn't pollute stdout).

### Changed

- v1.2.0 `RPC_URLS` lists were re-curated against live availability before
  tagging. Ankr (`rpc.ankr.com/*`) was removed across all chains — its free
  tier now rejects anonymous traffic with "you must authenticate your request
  with an API key", so `--rpc-quorum=majority|all` was silently degrading to
  single-provider mode. `eth.llamarpc.com` / `polygon.llamarpc.com` /
  `arbitrum.llamarpc.com` / `base.llamarpc.com` / `optimism.llamarpc.com` were
  also removed (broken TLS at the Cloudflare origin, dead DNS, or both),
  `polygon-rpc.com` was removed (API key required), `zksync-rpc.publicnode.com`
  was removed (empty responses), and `solana-rpc.publicnode.com` /
  `solana-mainnet.public.blastapi.io` were removed (broken TLS, dead DNS).
  Replacements are drpc.org subdomains, 1rpc.io/matic, eth.merkle.io, and
  solana.lava.build. Solana drops from 3 to 2 because the free-public-RPC
  landscape is genuinely sparse — no third no-API-key endpoint survives the
  same probe.
- `meta.partial` now flips to `true` when `rpc.disagreements[]` is non-empty,
  so existing `--strict` scripts pick up disagreements without a new exit
  code.
- URL redaction (credentials and query strings stripped) now happens at the
  output envelope boundary in `src/output/serialize.js`, not inside the
  per-adapter helpers. Envelope URLs are always safe to log.
- Solana's `solanaQuorum()` helper was rewritten to match the EVM
  `queryQuorum()` contract. `any` remains sequential; `majority`/`all` are
  parallel.
- README rewritten to describe these semantics accurately, including the
  privacy disclosure that `majority`/`all` modes fan the queried address out
  to every provider in the chain's array in parallel.

### Notes

- Bitcoin remains single-endpoint. The `mempool.space → blockstream.info`
  arrangement is a gas-only fallback for the `gas` command, not a quorum.
- glnc does not verify on-chain truth. `--rpc-quorum=majority` surfaces
  vendor disagreement; the user decides what to do about it.

## [1.1.1] — 2026

- Guard CSV cells against spreadsheet formula injection in `glnc history`.

## [1.1.0] — 2026

- FIFO cost basis (`--cost-basis fifo`) for `glnc history`, including
  ordinary-income surfacing for non-own-wallet inbound transfers and the
  `--own-wallets` flag. EVM chains only: ethereum, polygon, arbitrum, base,
  optimism. Incompatible with `--no-prices`.
- Five new CSV columns: `cost_basis_usd`, `proceeds_usd`,
  `realized_gain_usd`, `holding_period`, `income_usd`.

## [1.0.10] — earlier

- Interactive TUI hardening: NDJSON-correct rendering, required-wins state
  machine, CSI parser fixes, watch cleanup.
