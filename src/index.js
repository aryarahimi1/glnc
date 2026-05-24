/**
 * src/index.js
 *
 * Orchestration layer — dispatches parsed args to balance or tx workflows,
 * runs chain queries in parallel, fetches prices, and drives rendering.
 *
 * Exports:
 *   runBalance(addresses, chainFilter, opts?) => Promise<void>
 *   runWatch(addresses, chainFilter, opts?)   => Promise<void>
 *   runTx(txHash, chain, opts?)               => Promise<void>
 *
 * opts.json      — emit a single JSON document on stdout, skip pretty rendering
 * opts.verbose   — show full addresses
 * opts.watch     — (internal) running inside watch loop
 * opts.interval  — seconds between watch refreshes
 * opts.positions — fetch DeFi positions via src/positions/index.js
 *
 * Exit codes:
 *   0 — success
 *   1 — user error (bad address / hash / command)
 *   2 — all network requests failed
 *   3 — partial result (some sources degraded) — only under --strict
 */

// EVM chains that consult the Uniswap token list. Used to scope which
// per-chain token-list metas we collect into the envelope meta block.
const EVM_TOKEN_LIST_CHAINS = ['ethereum', 'polygon', 'arbitrum', 'base', 'optimism', 'linea', 'zksync'];

import { getAddress } from 'viem';
import {
  getPrices,
  getPricesWithMeta,
  getTokenPricesWithMeta,
  mergePricesMeta,
} from './prices.js';
import { getTokenListMeta, mergeTokenListMetas } from './tokens/index.js';
import { readSnapshot, writeSnapshot } from './snapshots.js';
import { isBitcoinLegacyChecksumValid } from './chains/_base58check.js';
import { isBitcoinBech32Valid } from './chains/_bech32.js';
import { wrap, wrapError, wrapEvent } from './output/envelope.js';
import { emitJSON, emitNDJSON } from './output/emit.js';
import { SCHEMA } from './output/schemas.js';
import {
  jsonSafeQuorum,
  jsonSafeQuorumValue,
  redactUrl,
  buildDisagreementEntry,
  isDisagreement,
} from './output/serialize.js';

export { runAlert } from './alert/index.js';
export { runHistory } from './history/run.js';

let _filterDust = null;
async function loadFilterDust() {
  if (_filterDust) return _filterDust;
  try {
    const mod = await import('./tokens/filter.js');
    _filterDust = mod.filterDust;
    return _filterDust;
  } catch {
    return null;
  }
}

import {
  renderBalances,
  renderWalletHeader,
  renderPortfolioTotal,
  renderWatchHeader,
  renderTransaction,
  renderError,
  printFetching,
  printFetchDone,
  createSpinner,
  createMultiSpinner,
  renderGas,
  c,
} from './cli/render.js';
import { getAllGas, GAS_CHAINS, EVM_GAS_CHAINS } from './gas.js';
import { EVM_CHAINS } from './chains/index.js';

// ---------------------------------------------------------------------------
// Address type detection
// ---------------------------------------------------------------------------

/**
 * Detect which chains are relevant for a given address string.
 * Returns an array of canonical chain names.
 *
 * @param {string} address
 * @returns {string[]}
 */
export function detectChains(address) {
  // EVM: 0x followed by exactly 40 hex characters
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return [...EVM_CHAINS];
  }

  // Bitcoin bech32/bech32m (native SegWit incl. Taproot): bc1...
  // Full BIP-173/BIP-350 checksum verification so a typo'd bc1 string is
  // rejected here rather than silently routed to Bitcoin and returning a
  // misleading "0 BTC" or a noisy upstream API error.
  if (/^bc1[ac-hj-np-z02-9]{6,87}$/i.test(address) && isBitcoinBech32Valid(address)) {
    return ['bitcoin'];
  }

  // Bitcoin legacy P2PKH (1...) or P2SH (3...). Uses base58check verification
  // so the 32-34 char overlap with Solana pubkeys is resolved deterministically:
  // strings that don't checksum-validate as Bitcoin fall through to Solana.
  if (
    /^[13][a-km-zA-HJ-NP-Z1-9]{25,33}$/.test(address) &&
    isBitcoinLegacyChecksumValid(address)
  ) {
    return ['bitcoin'];
  }

  // Solana: base58 string, 32–44 chars, no 0x prefix
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return ['solana'];
  }

  return [];
}

// Mixed-case EVM addresses claim to be EIP-55 checksummed; viem's getAddress throws on a bad one.
function evmChecksumIssue(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  if (addr.toLowerCase() === addr || addr.toUpperCase() === addr) return null;
  try { getAddress(addr); return null; }
  catch { return `Address has an invalid EIP-55 checksum — verify you copied it correctly: ${addr}`; }
}

// ---------------------------------------------------------------------------
// Dynamic module loaders
// ---------------------------------------------------------------------------

/**
 * Lazily import a chain adapter module.
 *
 * Static dispatch map: bun build --compile cannot statically resolve template
 * dynamic imports (`import(\`./chains/${chain}.js\`)`), so chain modules would
 * silently drop from the bundle and every adapter lookup would return null.
 * Listing each chain as a literal-path import keeps lazy semantics while
 * letting the bundler include them.
 *
 * @param {string} chain
 * @returns {Promise<{getBalances: Function, getTransaction?: Function}|null>}
 */
async function loadChainAdapter(chain) {
  try {
    switch (chain) {
      case 'ethereum': return await import('./chains/ethereum.js');
      case 'polygon':  return await import('./chains/polygon.js');
      case 'arbitrum': return await import('./chains/arbitrum.js');
      case 'base':     return await import('./chains/base.js');
      case 'optimism': return await import('./chains/optimism.js');
      case 'linea':    return await import('./chains/linea.js');
      case 'zksync':   return await import('./chains/zksync.js');
      case 'solana':   return await import('./chains/solana.js');
      case 'bitcoin':  return await import('./chains/bitcoin.js');
      default:         return null;
    }
  } catch {
    return null;
  }
}

/**
 * Lazily import the transaction decoder module.
 *
 * @returns {Promise<{decodeTransaction: Function}|null>}
 */
let _decoderOverride = null;
async function loadDecoder() {
  if (_decoderOverride) return _decoderOverride;
  try {
    return await import('./decoders/index.js');
  } catch {
    return null;
  }
}
// @internal test-only — inject a decoder stub. Pass null to restore default.
function __setDecoderForTest(d) {
  if (process.env.NODE_ENV !== 'test' && process.env.GLNC_TEST !== '1') {
    throw new Error('__setDecoderForTest is a test-only hook; set NODE_ENV=test or GLNC_TEST=1');
  }
  _decoderOverride = d;
}

/**
 * Lazily import the ENS resolver (written by concurrent agent).
 * Returns null if not yet available.
 *
 * @returns {Promise<{resolveAddress: Function, reverseResolveAddress: Function}|null>}
 */
async function loadEnsResolver() {
  try {
    return await import('./resolvers/ens.js');
  } catch {
    return null;
  }
}

/**
 * Lazily import the DeFi positions module (written by concurrent agent).
 *
 * @returns {Promise<{getPositions: Function}|null>}
 */
async function loadPositions() {
  try {
    return await import('./positions/index.js');
  } catch {
    return null;
  }
}

/**
 * Lazily import the NFT holdings module. Returns null if unavailable.
 *
 * @returns {Promise<{getNftHoldings: Function}|null>}
 */
async function loadNfts() {
  try {
    return await import('./nfts/index.js');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

/**
 * Build a semaphore that limits concurrent async operations to `n`.
 *
 * @param {number} n
 * @returns {(fn: () => Promise<any>) => Promise<any>}
 */
function makeSemaphore(n) {
  let active = 0;
  const queue = [];
  return async function run(fn) {
    if (active < n) {
      active++;
      try {
        return await fn();
      } finally {
        active--;
        queue.shift()?.();
      }
    }
    return new Promise((res, rej) =>
      queue.push(async () => {
        active++;
        try {
          res(await fn());
        } catch (e) {
          rej(e);
        } finally {
          active--;
          queue.shift()?.();
        }
      })
    );
  };
}

// ---------------------------------------------------------------------------
// Core query logic — shared by runBalance and runWatch
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   resolvedAddress: string,
 *   displayName: string | null,
 *   chains: string[],
 *   results: Array<{ chain: string, result: any, error: Error|null }>,
 *   positions: any | null,
 * }} WalletResult
 */

/**
 * Resolve an input (ENS name or raw address) to a display name + EVM address.
 * Falls back to the raw input if the ENS module is unavailable.
 *
 * @param {string} input
 * @param {{ resolveAddress: Function } | null} ensMod
 * @returns {Promise<{ resolvedAddress: string, displayName: string|null, skipped: boolean, skipReason: string|null }>}
 */
async function resolveInput(input, ensMod) {
  if (ensMod) {
    try {
      const result = await ensMod.resolveAddress(input);
      if (result.address === null) {
        return {
          resolvedAddress: null,
          displayName: null,
          skipped: true,
          skipReason: result.error ?? `Could not resolve "${input}"`,
        };
      }
      return {
        resolvedAddress: result.address,
        displayName: result.displayName ?? null,
        skipped: false,
        skipReason: null,
      };
    } catch {
      // ENS resolution failed unexpectedly — fall through to raw input
    }
  }

  // No ENS module or resolution error: treat input as raw address
  return {
    resolvedAddress: input,
    displayName: null,
    skipped: false,
    skipReason: null,
  };
}

/**
 * Query all relevant chains for a single resolved address.
 * Returns structured results including positions if requested.
 *
 * @param {string} resolvedAddress
 * @param {string|null} chainFilter
 * @param {{ json?: boolean, positions?: boolean }} opts
 * @param {(fn: () => Promise<any>) => Promise<any>} sem  - shared semaphore
 * @returns {Promise<WalletResult>}
 */
async function queryWallet(resolvedAddress, chainFilter, opts, sem) {
  const machine = !!opts.json || !!opts.ndjson;

  let chains;
  if (chainFilter) {
    chains = [chainFilter];
  } else {
    chains = detectChains(resolvedAddress);
  }

  if (chains.length === 0) {
    return { resolvedAddress, displayName: null, chains: [], results: [], positions: null };
  }

  // Per-wallet multi-spinner — never created when stdout is structured output
  // (--json or --ndjson), since the spinner writes ANSI to stderr that
  // interleaves with downstream pipelines on shared TTYs.
  const multiSpinner = (!machine && chains.length > 0)
    ? createMultiSpinner(chains)
    : null;

  const queries = chains.map(chain =>
    sem(async () => {
      const adapter = await loadChainAdapter(chain);
      const t0 = Date.now();
      if (!adapter) {
        multiSpinner?.update(chain, 'fail', Date.now() - t0);
        return {
          chain,
          result: null,
          error: new Error(`Chain adapter for "${chain}" is not yet available`),
        };
      }
      try {
        const result = await adapter.getBalances({
          address: resolvedAddress,
          rpcQuorum: opts.rpcQuorum ?? 'any',
        });
        const ms = Date.now() - t0;
        multiSpinner?.update(chain, result.error ? 'fail' : 'ok', ms);
        return { chain, result, error: null };
      } catch (err) {
        multiSpinner?.update(chain, 'fail', Date.now() - t0);
        return { chain, result: null, error: err };
      }
    })
  );

  const settled = await Promise.allSettled(queries);
  multiSpinner?.stop();

  const results = settled.map(s =>
    s.status === 'fulfilled'
      ? s.value
      : { chain: '?', result: null, error: s.reason }
  );

  // Dust filtering for EVM chains
  const filterDust = await loadFilterDust();
  if (filterDust) {
    // Build a quick price set from results (prices fetched outside)
    const evmSet = new Set(EVM_CHAINS);
    // We'll apply dust filtering after price fetch in fetchBalances
  }

  // DeFi positions (optional)
  let positionsResult = null;
  if (opts.positions) {
    const posMod = await loadPositions();
    if (posMod) {
      const evmChains = chains.filter(c =>
        ['ethereum', 'polygon', 'arbitrum', 'base'].includes(c)
      );
      if (evmChains.length > 0) {
        // __error: top-level error marker distinguishes a full-call failure
        // from per-chain keys; consumed by the render path, scrubbed from JSON.
        positionsResult = await posMod
          .getPositions(resolvedAddress, evmChains)
          .catch(err => ({ __error: err?.message ?? String(err) }));
      }
    }
  }

  // NFT holdings (optional) — Reservoir API, EVM only.
  let nftsResult = null;
  if (opts.nfts) {
    const nftMod = await loadNfts();
    if (nftMod) {
      const evmNftChains = chains.filter(c =>
        ['ethereum', 'polygon', 'arbitrum', 'base', 'optimism'].includes(c)
      );
      if (evmNftChains.length > 0) {
        if (!process.env.RESERVOIR_API_KEY) {
          nftsResult = { __error: 'RESERVOIR_API_KEY environment variable not set' };
        } else {
          nftsResult = await nftMod
            .getNftHoldings(resolvedAddress, evmNftChains, {
              apiKey: process.env.RESERVOIR_API_KEY,
            })
            .catch(err => ({ __error: err?.message ?? String(err) }));
        }
      }
    }
  }

  return {
    resolvedAddress,
    displayName: null,
    chains,
    results,
    positions: positionsResult,
    nfts: nftsResult,
  };
}

/**
 * Short, recognizable provider name extracted from an RPC URL. Falls back to
 * the hostname (sans `www.` and TLD) when no friendly form is obvious.
 *
 * @param {string} url
 * @returns {string}
 */
function shortProviderName(url) {
  try {
    const { hostname } = new URL(url);
    // Strip leading www. and trailing TLD; keep the middle "brand" segment.
    const host = hostname.replace(/^www\./, '');
    const parts = host.split('.');
    if (parts.length <= 1) return host;
    // For `eth.llamarpc.com` / `ethereum-rpc.publicnode.com` / `rpc.ankr.com`
    // the brand is the second-to-last label.
    const brand = parts[parts.length - 2];
    return brand || host;
  } catch {
    return url;
  }
}

/**
 * Format a single disagreement entry as a one-line stderr warning.
 *
 * @param {{chain:string,agreement:string,providers:Array<{url:string,value:any}>}} entry
 * @param {'balance'|'transaction'} flow
 * @returns {string}
 */
function formatDisagreementWarning(entry, flow) {
  const short = v => {
    if (v == null) return '—';
    const s = String(v);
    // 0x-prefixed hashes / long hex strings: 0xabcd…1234
    if (/^0x[0-9a-fA-F]{16,}$/.test(s)) return `${s.slice(0, 6)}…${s.slice(-4)}`;
    return s.length > 24 ? s.slice(0, 23) + '…' : s;
  };
  const pairs = entry.providers
    .filter(p => p.value !== null && p.value !== undefined)
    .map(p => `${shortProviderName(p.url)}=${short(p.value)}`)
    .join(', ');
  const kind = flow === 'transaction' ? 'transaction disagreement' : 'balance disagreement';
  return `${c.yellow('!')} ${entry.chain}: ${kind} (${pairs}) — using ${entry.agreement}`;
}

/**
 * Emit one stderr line per disagreement when stderr is an interactive TTY and
 * structured output (`--json` / `--ndjson`) is not active. Silent otherwise so
 * piped / redirected stderr stays clean (preserves the contract documented in
 * README around the stdout/stderr split).
 *
 * @param {Array<object>|undefined} disagreements
 * @param {'balance'|'transaction'} flow
 * @param {{json?:boolean,ndjson?:boolean}} opts
 */
function maybeEmitDisagreementWarnings(disagreements, flow, opts) {
  if (opts.json || opts.ndjson) return;
  if (!process.stderr.isTTY) return;
  if (!Array.isArray(disagreements) || disagreements.length === 0) return;
  for (const entry of disagreements) {
    process.stderr.write(formatDisagreementWarning(entry, flow) + '\n');
  }
}

/**
 * Format a single quorum-degradation entry as a one-line stderr warning.
 *
 * @param {{chain:string,requested:'majority'|'all',agreement:string,fulfilledCount:number,totalCount:number}} entry
 * @returns {string}
 */
function formatDegradationWarning(entry) {
  return `${c.yellow('!')} ${entry.chain}: quorum degraded (${entry.requested} requested, ${entry.fulfilledCount}/${entry.totalCount} RPCs responded) — see meta.sources.rpc.degraded`;
}

/**
 * Emit one stderr line per degraded-quorum chain. Same suppression contract as
 * maybeEmitDisagreementWarnings: silent under --json/--ndjson and on non-TTY
 * stderr. Watch path opts out by not calling this helper.
 *
 * @param {Array<object>|undefined} degraded
 * @param {'balance'|'transaction'} _flow
 * @param {{json?:boolean,ndjson?:boolean}} opts
 */
function maybeEmitDegradationWarnings(degraded, _flow, opts) {
  if (opts.json || opts.ndjson) return;
  if (!process.stderr.isTTY) return;
  if (!Array.isArray(degraded) || degraded.length === 0) return;
  for (const entry of degraded) {
    process.stderr.write(formatDegradationWarning(entry) + '\n');
  }
}

/**
 * Build a single degradation record from a one-shot quorum block (used by the
 * tx flow which doesn't go through the wallet aggregator). Returns null when
 * the user did not request majority/all, or when the quorum was fully served.
 *
 * @param {string} chain
 * @param {{agreement?:string, sources?:Array<{status:string}>}|undefined} quorum
 * @param {string|undefined} requested
 * @returns {{chain:string,requested:'majority'|'all',agreement:string,fulfilledCount:number,totalCount:number}|null}
 */
function buildDegradationEntry(chain, quorum, requested) {
  if (requested !== 'majority' && requested !== 'all') return null;
  if (!quorum || !Array.isArray(quorum.sources)) return null;
  const fulfilledCount = quorum.sources.filter(s => s.status === 'fulfilled').length;
  const totalCount = quorum.sources.length;
  if (totalCount <= 1) return null;
  const threshold = requested === 'all' ? totalCount : Math.floor(totalCount / 2) + 1;
  if (fulfilledCount >= threshold) return null;
  return { chain, requested, agreement: quorum.agreement, fulfilledCount, totalCount };
}

/**
 * Walk wallet results and produce one degradation entry per chain whose
 * quorum call returned fewer fulfilled providers than the user requested
 * (majority/all). Dedup is by chain — N wallets hitting the same chain
 * surface once.
 *
 * @param {Array<{results: Array<{chain: string, result?: any, error?: any}>}>} wallets
 * @param {'majority'|'all'} requested
 * @returns {Array<{chain:string,requested:'majority'|'all',agreement:string,fulfilledCount:number,totalCount:number}>}
 */
function collectDegradationsFromWallets(wallets, requested) {
  const out = [];
  const seen = new Set();
  for (const wallet of wallets) {
    for (const r of wallet.results) {
      if (r.error || r.result?.error) continue;
      const quorum = r.result?.quorum;
      if (!quorum || !Array.isArray(quorum.sources)) continue;
      const fulfilledCount = quorum.sources.filter(s => s.status === 'fulfilled').length;
      const totalCount = quorum.sources.length;
      const threshold = requested === 'all' ? totalCount : Math.floor(totalCount / 2) + 1;
      if (totalCount <= 1 || fulfilledCount >= threshold) continue;
      if (seen.has(r.chain)) continue;
      seen.add(r.chain);
      out.push({
        chain: r.chain,
        requested,
        agreement: quorum.agreement,
        fulfilledCount,
        totalCount,
      });
    }
  }
  return out;
}

/**
 * Walk wallet results and produce one disagreement entry per unique
 * (chain, sorted dissenter URLs) pair. Keeps two same-chain wallets that
 * dissent on different providers from collapsing into a single entry.
 *
 * @param {Array<{results: Array<{chain: string, result?: any, error?: any}>}>} wallets
 * @returns {Array<object>}
 */
function collectDisagreementsFromWallets(wallets) {
  const out = [];
  const seen = new Set();
  for (const wallet of wallets) {
    for (const r of wallet.results) {
      if (r.error || r.result?.error) continue;
      if (!r.result?.quorum || !isDisagreement(r.result.quorum)) continue;
      const dissenters = (r.result.quorum.disagreements ?? []).map(d => d.url).sort().join('|');
      const key = r.chain + ':' + dissenters;
      if (seen.has(key)) continue;
      const entry = buildDisagreementEntry(r.chain, r.result);
      if (entry) {
        out.push(entry);
        seen.add(key);
      }
    }
  }
  return out;
}

/**
 * Fetch balances for one or more addresses.
 * Handles ENS resolution, multi-wallet concurrency, price fetching,
 * and dust filtering. Does NOT render anything.
 *
 * @param {string | string[]} addressInput
 * @param {string|null} chainFilter
 * @param {{ json?: boolean, verbose?: boolean, positions?: boolean }} opts
 * @returns {Promise<{ wallets: WalletResult[], prices: Record<string, number>, meta: object }>}
 */
async function fetchBalances(addressInput, chainFilter, opts) {
  const addresses = Array.isArray(addressInput) ? addressInput : [addressInput];
  const json = !!opts.json;

  // Load ENS resolver lazily — OK if absent
  const ensMod = await loadEnsResolver();

  // Semaphore: cap at 8 concurrent chain queries across all wallets
  const sem = makeSemaphore(8);

  // Resolve all addresses in parallel (ENS pre-flight)
  const resolutions = await Promise.all(addresses.map(addr => resolveInput(addr, ensMod)));

  // Query wallets in parallel (semaphore shared across all chains)
  const walletPromises = resolutions.map(async (res, idx) => {
    if (res.skipped) {
      if (!json) {
        renderError(`Skipping "${addresses[idx]}": ${res.skipReason}`);
      }
      return null;
    }

    const walletResult = await queryWallet(res.resolvedAddress, chainFilter, opts, sem);
    // Attach the display name from ENS resolution
    walletResult.displayName = res.displayName;
    return walletResult;
  });

  const walletSettled = await Promise.all(walletPromises);
  // Filter out skipped wallets
  const wallets = walletSettled.filter(w => w !== null);

  // Collect all unique symbols for price lookup
  const symbols = new Set();
  for (const wallet of wallets) {
    for (const { result } of wallet.results) {
      if (!result || result.error) continue;
      if (result.native?.symbol) symbols.add(result.native.symbol.toUpperCase());
      for (const t of result.tokens ?? []) {
        if (t.symbol) symbols.add(t.symbol.toUpperCase());
      }
    }
  }

  let prices = {};
  let symbolMeta = null;
  if (symbols.size > 0) {
    try {
      const got = await getPricesWithMeta([...symbols]);
      prices = got.prices;
      symbolMeta = got.meta;
    } catch {
      // Non-fatal — render without USD values; flag prices as not OK below.
      symbolMeta = { ok: false, provider: 'coingecko', cacheAgeSec: 0, stale: false, rateLimited: false, unpriced: [] };
    }
  }

  // Fill in prices for EVM tokens that have a contract address but no symbol-
  // based price (e.g. long-tail tokens absent from SYMBOL_TO_ID).
  const evmSet = new Set(EVM_CHAINS);
  const contractsByChain = new Map();
  for (const wallet of wallets) {
    for (const { chain, result } of wallet.results) {
      if (!result || result.error) continue;
      if (!evmSet.has(chain)) continue;
      for (const token of result.tokens ?? []) {
        if (!token.contract || !token.symbol) continue;
        if (prices[token.symbol.toUpperCase()] !== undefined) continue;
        if (!contractsByChain.has(chain)) contractsByChain.set(chain, []);
        contractsByChain.get(chain).push({ addr: token.contract.toLowerCase(), sym: token.symbol.toUpperCase() });
      }
    }
  }
  const contractMetas = [];
  for (const [chain, entries] of contractsByChain) {
    try {
      const addrs = [...new Set(entries.map(e => e.addr))];
      const got = await getTokenPricesWithMeta(chain, addrs);
      contractMetas.push(got.meta);
      for (const { addr, sym } of entries) {
        if (got.prices[addr] !== undefined && prices[sym] === undefined) {
          prices[sym] = got.prices[addr];
        }
      }
    } catch {
      contractMetas.push({ ok: false, provider: 'coingecko', cacheAgeSec: 0, stale: false, rateLimited: false, unpriced: [] });
    }
  }

  // ── Aggregate meta ────────────────────────────────────────────────────────
  const pricesMeta = mergePricesMeta(symbolMeta, ...contractMetas);

  // Collect chains touched (across all wallets) + which failed + which provider
  // URL ultimately answered for each successful chain. Failed chains are
  // omitted from `providers` (no winning URL to attribute).
  const chainsTouched = new Set();
  const chainsFailed = new Set();
  const providers = {};
  const disagreements = [];
  for (const wallet of wallets) {
    for (const r of wallet.results) {
      chainsTouched.add(r.chain);
      if (r.error || r.result?.error) chainsFailed.add(r.chain);
      else if (r.result?.source && providers[r.chain] === undefined) {
        providers[r.chain] = redactUrl(r.result.source);
      }
    }
  }
  // Surface RPC quorum divergence so consumers can detect conflicting provider
  // responses. Dedup is by (chain, sorted dissenter URLs) so two wallets on
  // the same chain with different dissenters both surface.
  disagreements.push(...collectDisagreementsFromWallets(wallets));
  // Quorum degradation: only meaningful when user actually requested majority/all.
  const requestedQuorum = opts?.rpcQuorum;
  const degraded =
    requestedQuorum === 'majority' || requestedQuorum === 'all'
      ? collectDegradationsFromWallets(wallets, requestedQuorum)
      : [];
  const rpcMeta = {
    ok: chainsFailed.size === 0,
    chainsFailed: [...chainsFailed],
    providers,
    disagreements,
    degraded,
  };

  // Per-chain token-list meta for any EVM chain we touched
  const tokenMetas = [];
  for (const chain of chainsTouched) {
    if (!EVM_TOKEN_LIST_CHAINS.includes(chain)) continue;
    const m = getTokenListMeta(chain);
    if (m) tokenMetas.push(m);
  }
  const tokenListMeta = tokenMetas.length > 0
    ? mergeTokenListMetas(...tokenMetas)
    : null;

  const partial =
    !rpcMeta.ok ||
    rpcMeta.disagreements.length > 0 ||
    rpcMeta.degraded.length > 0 ||
    (pricesMeta && pricesMeta.ok === false) ||
    (tokenListMeta && tokenListMeta.fallback === true);

  const meta = {
    sources: {
      rpc: rpcMeta,
      ...(pricesMeta ? { prices: pricesMeta } : {}),
      ...(tokenListMeta ? { tokenList: tokenListMeta } : {}),
    },
    partial: !!partial,
    warnings: [],
  };

  // Apply dust filtering for EVM chains
  const filterDust = await loadFilterDust();
  if (filterDust) {
    const evmSet = new Set(EVM_CHAINS);
    for (const wallet of wallets) {
      for (const entry of wallet.results) {
        if (!entry.result || entry.error || entry.result.error) continue;
        if (!evmSet.has(entry.chain)) continue;
        const tokens = entry.result.tokens ?? [];
        if (tokens.length === 0) continue;
        try {
          entry.result.tokens = filterDust(tokens, prices, {
            showUnpriced: !!opts?.showUnpriced,
            chain: entry.chain,
          });
        } catch {
          // Non-fatal
        }
      }
    }
  }

  return { wallets, prices, meta };
}

// ---------------------------------------------------------------------------
// Balance command — public
// ---------------------------------------------------------------------------

/**
 * Run the balance command: detect chains, query in parallel, render results.
 *
 * @param {string | string[]} addresses   - one or more addresses / ENS names
 * @param {string|null} chainFilter
 * @param {{ json?: boolean, verbose?: boolean, positions?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function runBalance(addresses, chainFilter, opts = {}) {
  const json    = !!opts.json;
  const ndjson  = !!opts.ndjson;
  const strict  = !!opts.strict;
  const emit    = ndjson ? emitNDJSON : emitJSON;
  const verbose = !!opts.verbose;

  // Normalise to array
  const addrArray = Array.isArray(addresses) ? addresses : [addresses];

  // Validate that we have at least one address
  if (addrArray.length === 0) {
    const msg = 'Usage: glnc balance <address> [address2 ...] [--chain <name>]';
    if (json) {
      emit(wrapError(SCHEMA.BALANCE, msg, { code: 'usage' }));
    } else {
      renderError(msg);
    }
    process.exitCode = 1;
    return;
  }

  for (const a of addrArray) {
    const issue = evmChecksumIssue(a);
    if (issue) {
      if (json) emit(wrapError(SCHEMA.BALANCE, issue, { code: 'bad-checksum' }));
      else renderError(issue);
      process.exitCode = 1;
      return;
    }
  }

  // For single-address usage, validate chain detectability early (before fetch)
  if (addrArray.length === 1 && !chainFilter) {
    const ensMod = await loadEnsResolver();
    let checkAddr = addrArray[0];
    if (ensMod) {
      try {
        const r = await ensMod.resolveAddress(checkAddr);
        if (r.address !== null) checkAddr = r.address;
      } catch { /* fall through */ }
    }
    const chains = detectChains(checkAddr);
    if (chains.length === 0) {
      const supported = [...EVM_CHAINS, 'solana', 'bitcoin'].join(', ');
      const msg =
        `Could not detect chain for address: ${addrArray[0]}. ` +
        `Use --chain <name> to specify (${supported}).`;
      if (json) {
        emit(wrapError(SCHEMA.BALANCE, msg, { code: 'unknown-chain' }));
      } else {
        renderError(msg);
      }
      process.exitCode = 1;
      return;
    }
  }

  const { wallets, prices, meta } = await fetchBalances(addrArray, chainFilter, opts);

  // Surface RPC disagreements to interactive users (TTY stderr only, never in
  // structured output). Iterates the aggregator's deduped list, not wallets,
  // so multi-wallet runs hitting the same provider split warn once per chain.
  maybeEmitDisagreementWarnings(meta?.sources?.rpc?.disagreements, 'balance', { json, ndjson });
  maybeEmitDegradationWarnings(meta?.sources?.rpc?.degraded, 'balance', { json, ndjson });

  const multiWallet = addrArray.length > 1;

  if (json) {
    // JSON mode: emit all wallets in a single envelope, with source meta
    emit(wrap(SCHEMA.BALANCE, buildBalanceData(wallets, prices), meta));
    // Strict mode: partial result → exit 3 so scripts can gate on it.
    // Default behavior (no --strict) preserves exit 0 for backward compat.
    if (strict && meta?.partial) {
      process.exitCode = 3;
    }
    return;
  }

  // Pretty rendering
  const pricesMeta = meta?.sources?.prices ?? null;
  if (multiWallet) {
    for (const wallet of wallets) {
      renderWalletHeader(wallet.displayName, wallet.resolvedAddress, { verbose });
      renderBalances(wallet.results, prices, {
        verbose,
        positions: wallet.positions,
        nfts: wallet.nfts,
        pricesMeta,
      });
    }
    renderPortfolioTotal(wallets, prices);
  } else {
    const wallet = wallets[0];
    if (!wallet) {
      renderError('No wallets could be queried.');
      process.exitCode = 1;
      return;
    }
    renderBalances(wallet.results, prices, {
      verbose,
      positions: wallet.positions,
      nfts: wallet.nfts,
      pricesMeta,
    });
  }

  // If every chain of every wallet errored, signal network failure
  const allFailed = wallets.every(w =>
    w.results.length === 0 || w.results.every(r => r.error || r.result?.error)
  );
  if (allFailed && wallets.length > 0) {
    process.exitCode = 2;
  } else if (strict && meta?.partial) {
    // Partial result under --strict → exit 3. Takes precedence over 0 but
    // not over 2 (which is a strictly worse state).
    process.exitCode = 3;
  }
}

// ---------------------------------------------------------------------------
// Watch command — public
// ---------------------------------------------------------------------------

/**
 * Run the balance command in a continuous watch loop.
 *
 * @param {string | string[]} addresses
 * @param {string|null} chainFilter
 * @param {{ json?: boolean, verbose?: boolean, interval?: number, positions?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function runWatch(addresses, chainFilter, opts = {}) {
  const intervalSecs = typeof opts.interval === 'number' && opts.interval > 0
    ? opts.interval
    : 15;
  const verbose = !!opts.verbose;
  const json    = !!opts.json;
  const ndjson  = !!opts.ndjson;
  const machine = json || ndjson;
  const strict  = !!opts.strict;
  const addrArray = Array.isArray(addresses) ? addresses : [addresses];

  for (const a of addrArray) {
    const issue = evmChecksumIssue(a);
    if (issue) {
      if (machine) emitJSON(wrapError(SCHEMA.BALANCE, issue, { code: 'bad-checksum' }));
      else renderError(issue);
      process.exitCode = 1;
      return;
    }
  }

  let stopped = false;

  // Pretty mode uses the terminal's alternate screen buffer so the user's
  // scrollback is preserved across the watch session. Entered before the
  // first redraw, exited in `finally` (and on SIGINT) so Ctrl+C always
  // restores the previous screen contents.
  const useAltScreen = !machine && (process.stdout.isTTY ?? false);
  let altScreenActive = false;
  const enterAltScreen = () => {
    if (useAltScreen && !altScreenActive) {
      process.stdout.write('\x1b[?1049h');
      altScreenActive = true;
    }
  };
  const exitAltScreen = () => {
    if (altScreenActive) {
      process.stdout.write('\x1b[?1049l');
      altScreenActive = false;
    }
  };

  // Handle SIGINT/SIGTERM/SIGHUP cleanly — exit alt-screen so the user's
  // scrollback is restored before we surrender the foreground. SIGTERM and
  // SIGHUP must be covered too: parent-killed (`kill <pid>`) or terminal-
  // closed sessions would otherwise leave the alt-screen escape un-undone
  // and the listener leaked.
  const stopHandler = () => {
    stopped = true;
    exitAltScreen();
  };
  process.on('SIGINT',  stopHandler);
  process.on('SIGTERM', stopHandler);
  process.on('SIGHUP',  stopHandler);

  let lastRefreshMs = null;
  let prevPollData = null;
  let pollIndex = 0;

  // Visible signal that watch mode is starting — printed to the user's normal
  // scrollback BEFORE alt-screen takes over, so even if the first render
  // crashes they still see proof that watch mode engaged.
  if (!machine) {
    console.log(c.dim(`Entering watch mode (Ctrl+C to exit, refreshing every ${intervalSecs}s)...`));
  }

  try {
    while (!stopped) {
      const iterStart = Date.now();

      // In pretty mode we redraw the screen each tick. In structured-output
      // mode (--json or --ndjson) we never touch the screen — stdout is the
      // machine-readable stream.
      if (!machine) {
        enterAltScreen();
        // Move cursor home + clear screen *within the alt buffer*.
        process.stdout.write('\x1b[H\x1b[2J');
        renderWatchHeader(addrArray, intervalSecs, lastRefreshMs);
      }

      // Fetch balances; in JSON mode failures don't kill the loop unless --strict.
      let wallets, prices, pollMeta;
      try {
        ({ wallets, prices, meta: pollMeta } = await fetchBalances(addrArray, chainFilter, opts));
      } catch (err) {
        if (json) {
          emitNDJSON(wrapEvent(SCHEMA.BALANCE_WATCH, 'error', {
            ok: false,
            error: { code: 'fetch-failed', message: err?.message ?? String(err) },
            poll: pollIndex++,
          }));
          if (strict) break;
        } else {
          renderError(err?.message ?? String(err));
        }
        // Sleep before next attempt
        const deadline = Date.now() + intervalSecs * 1000;
        while (Date.now() < deadline && !stopped) {
          await new Promise(r => setTimeout(r, 100));
        }
        continue;
      }

      lastRefreshMs = Date.now() - iterStart;

      // Load previous snapshots and compute deltas, then write new snapshots.
      // (Snapshots persist across runs; the in-memory prevPollData captures
      //  intra-run deltas for NDJSON consumers without disk reads.)
      const walletDeltas = new Map(); // resolvedAddress -> Map<'chain:SYM', {prev,curr}>

      await Promise.all(
        wallets.map(async wallet => {
          const prevSnap = await readSnapshot(wallet.resolvedAddress);
          const deltas = new Map();

          if (prevSnap) {
            for (const { chain, result } of wallet.results) {
              if (!result || result.error) continue;
              const processAsset = (symbol, amount) => {
                const key = `${chain}:${symbol.toUpperCase()}`;
                const prev = prevSnap.get(key);
                if (!prev) return;
                const prevN = parseFloat(prev.amount);
                const currN = parseFloat(String(amount));
                if (isNaN(prevN) || isNaN(currN)) return;
                if (Math.abs(currN - prevN) > 0.0001) {
                  deltas.set(key, { prev: prev.amount, curr: String(amount) });
                }
              };
              if (result.native?.symbol && result.native?.amount != null) {
                processAsset(result.native.symbol, result.native.amount);
              }
              for (const token of result.tokens ?? []) {
                if (token.symbol && token.amount != null) {
                  processAsset(token.symbol, token.amount);
                }
              }
            }
          }

          walletDeltas.set(wallet.resolvedAddress, deltas);

          // Write new snapshot
          await writeSnapshot(wallet.resolvedAddress, wallet.results);
        })
      );

      // ── Output ──────────────────────────────────────────────────────────
      if (json) {
        const data = buildBalanceData(wallets, prices);
        const delta = diffBalanceData(prevPollData, data);
        emitNDJSON(wrapEvent(SCHEMA.BALANCE_WATCH, 'poll', {
          poll: pollIndex++,
          intervalSec: intervalSecs,
          fetchMs: lastRefreshMs,
          data,
          delta,
          meta: pollMeta,
        }));
        prevPollData = data;
      } else {
        try {
          const multiWallet = addrArray.length > 1;
          const pricesMeta = pollMeta?.sources?.prices ?? null;
          if (multiWallet) {
            for (const wallet of wallets) {
              renderWalletHeader(wallet.displayName, wallet.resolvedAddress, { verbose });
              renderBalances(wallet.results, prices, {
                verbose,
                positions: wallet.positions,
                nfts: wallet.nfts,
                deltas: walletDeltas.get(wallet.resolvedAddress),
                pricesMeta,
              });
            }
            renderPortfolioTotal(wallets, prices);
          } else {
            const wallet = wallets[0];
            if (wallet) {
              renderBalances(wallet.results, prices, {
                verbose,
                positions: wallet.positions,
                nfts: wallet.nfts,
                deltas: walletDeltas.get(wallet.resolvedAddress),
                pricesMeta,
              });
            }
          }
        } catch (renderErr) {
          // Surface the crash inside alt-screen so the user can see it; do
          // NOT exit alt-screen — that would hide the error.
          console.log('');
          console.log(c.red('  Render error: ') + (renderErr?.message ?? String(renderErr)));
          console.log(c.dim('  (will retry on next tick — press Ctrl+C to exit)'));
        }
      }

      if (stopped) break;

      // Wait intervalSecs, polling SIGINT flag every 100ms
      const deadline = Date.now() + intervalSecs * 1000;
      while (Date.now() < deadline && !stopped) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  } finally {
    process.removeListener('SIGINT',  stopHandler);
    process.removeListener('SIGTERM', stopHandler);
    process.removeListener('SIGHUP',  stopHandler);
    exitAltScreen();
    if (json) {
      emitNDJSON(wrapEvent(SCHEMA.BALANCE_WATCH, 'stop', {
        reason: 'signal',
        poll: pollIndex,
      }));
    } else {
      console.log(c.dim('\nStopped.'));
    }
  }
}

// ---------------------------------------------------------------------------
// JSON helpers — the canonical "data" payload for balance commands
// ---------------------------------------------------------------------------

/**
 * Build the balance JSON data block, shared by runBalance (single document)
 * and runWatch (one per poll). Stable shape:
 *
 *   { wallets: [{address, displayName, chains:[...], grandTotalUsd}], totalUsd }
 *
 * @param {WalletResult[]} wallets
 * @param {Record<string, number>} prices
 * @returns {object}
 */
function buildBalanceData(wallets, prices) {
  let totalUsd = 0;
  let totalKnown = true;
  const walletsOut = wallets.map(wallet => {
    const chainsOut = buildJsonChains(
      wallet.resolvedAddress, wallet.chains, wallet.results, prices,
    );
    if (chainsOut.grandTotalUsd === null) {
      totalKnown = false;
    } else {
      totalUsd += chainsOut.grandTotalUsd;
    }
    // Scrub __error sentinel — JSON consumers see null (matching pre-1.0.9
    // silent-null behavior) rather than an internal render-only shape.
    const nftsOut = wallet.nfts && wallet.nfts.__error ? null : (wallet.nfts ?? null);
    return {
      address: wallet.resolvedAddress,
      displayName: wallet.displayName,
      chains: chainsOut.chains,
      grandTotalUsd: chainsOut.grandTotalUsd,
      nfts: nftsOut,
    };
  });
  return { wallets: walletsOut, totalUsd: totalKnown ? totalUsd : null };
}

/**
 * Diff two balance-data snapshots. Returns null if there is no previous
 * snapshot (first poll) or if neither snapshot has a usable total.
 *
 * @param {object} prev
 * @param {object} curr
 * @returns {{ totalUsdDelta: number|null, perAsset: Array<object> }}
 */
function diffBalanceData(prev, curr) {
  if (!prev || !curr) return { totalUsdDelta: null, perAsset: [] };
  const totalUsdDelta = (prev.totalUsd != null && curr.totalUsd != null)
    ? curr.totalUsd - prev.totalUsd
    : null;
  const perAsset = [];
  const buildIndex = data => {
    const idx = new Map();
    for (const w of data.wallets ?? []) {
      for (const ch of w.chains ?? []) {
        for (const a of ch.assets ?? []) {
          const key = `${w.address}|${ch.chain}|${a.symbol}`;
          idx.set(key, { address: w.address, chain: ch.chain, asset: a });
        }
      }
    }
    return idx;
  };
  const prevIdx = buildIndex(prev);
  const currIdx = buildIndex(curr);
  for (const [key, { address, chain, asset }] of currIdx) {
    const prevEntry = prevIdx.get(key);
    if (!prevEntry) continue;
    const prevAmt = parseFloat(prevEntry.asset.amount);
    const currAmt = parseFloat(asset.amount);
    if (isNaN(prevAmt) || isNaN(currAmt)) continue;
    if (Math.abs(currAmt - prevAmt) <= 0.0000001) continue;
    perAsset.push({
      address, chain, symbol: asset.symbol,
      prevAmount: prevEntry.asset.amount,
      currAmount: asset.amount,
      delta: currAmt - prevAmt,
      prevValueUsd: prevEntry.asset.valueUsd,
      currValueUsd: asset.valueUsd,
    });
  }
  return { totalUsdDelta, perAsset };
}

// ---------------------------------------------------------------------------
// JSON helper (used by runBalance JSON path)
// ---------------------------------------------------------------------------

/**
 * Build the structured JSON representation of chain results.
 *
 * @param {string} address
 * @param {string[]} chains
 * @param {Array<{ chain: string, result: any, error: Error|null }>} results
 * @param {Record<string, number>} prices
 * @returns {{ chains: any[], grandTotalUsd: number|null }}
 */
function buildJsonChains(address, chains, results, prices) {
  let grandTotalUsd = 0;
  let totalKnown = true;

  const chainsOut = results.map(({ chain, result, error }) => {
    if (error) {
      totalKnown = false;
      return { chain, error: error.message ?? String(error), assets: [], totalUsd: null };
    }
    if (result?.error) {
      totalKnown = false;
      return { chain, error: result.error, assets: [], totalUsd: null };
    }

    const assets = [];
    let chainTotalUsd = 0;
    let chainTotalKnown = true;

    const pushAsset = (entry, isNative) => {
      const symbol = entry.symbol;
      const amount = entry.amount;
      const decimals = entry.decimals ?? 18;
      const n = typeof amount === 'string' ? parseFloat(amount) : amount;
      const price = prices[symbol?.toUpperCase()];
      const usd = price !== undefined && !isNaN(n) ? n * price : null;
      if (usd === null) {
        chainTotalKnown = false;
      } else {
        chainTotalUsd += usd;
      }
      assets.push({
        symbol,
        amount: typeof amount === 'string' ? amount : String(amount),
        decimals,
        contract: entry.contract ?? null,
        native: isNative,
        priceUsd: price ?? null,
        valueUsd: usd,
      });
    };

    if (result?.native) pushAsset(result.native, true);
    for (const t of result?.tokens ?? []) pushAsset(t, false);

    if (chainTotalKnown) {
      grandTotalUsd += chainTotalUsd;
    } else {
      totalKnown = false;
    }

    // Freshness + provenance: surface the per-chain block height (EVM) or
    // slot (Solana) and the winning provider URL onto the JSON output so
    // consumers can attribute the data. `quorum` is preserved when present
    // so callers running --rpc-quorum=majority can see the per-chain
    // agreement metadata alongside the aggregated meta.disagreements.
    const out = {
      chain,
      error: null,
      assets,
      totalUsd: chainTotalKnown ? chainTotalUsd : null,
    };
    if (result?.source !== undefined) out.source = redactUrl(result.source);
    if (result?.blockNumber !== undefined) out.blockNumber = result.blockNumber;
    if (result?.slot !== undefined) out.slot = result.slot;
    if (result?.quorum) out.quorum = redactQuorumUrls(jsonSafeQuorum(result.quorum));
    return out;
  });

  return {
    chains: chainsOut,
    grandTotalUsd: totalKnown ? grandTotalUsd : null,
  };
}

// ---------------------------------------------------------------------------
// TX command
// ---------------------------------------------------------------------------

/**
 * Redact `url` fields inside a (jsonSafe) adapter quorum block, in place-safe
 * fashion. Used at the output boundary in the raw tx path to keep credentials
 * out of the emitted envelope.
 *
 * @param {{ agreement?: string, disagreements?: any[], sources?: any[] }} quorum
 * @returns {object}
 */
function redactQuorumUrls(quorum) {
  if (!quorum || typeof quorum !== 'object') return quorum;
  return {
    ...quorum,
    sources: Array.isArray(quorum.sources)
      ? quorum.sources.map(s => (s && s.url ? { ...s, url: redactUrl(s.url) } : s))
      : quorum.sources,
    disagreements: Array.isArray(quorum.disagreements)
      ? quorum.disagreements.map(d => (d && d.url ? { ...d, url: redactUrl(d.url) } : d))
      : quorum.disagreements,
  };
}

/**
 * Run the tx command: decode a transaction and render the summary.
 *
 * @param {string} txHash
 * @param {string|null} chain  - defaults to 'ethereum'
 * @param {{ json?: boolean, verbose?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function runTx(txHash, chain, opts = {}) {
  const json    = !!opts.json;
  const ndjson  = !!opts.ndjson;
  const machine = json || ndjson;
  const emit    = ndjson ? emitNDJSON : emitJSON;
  const verbose = !!opts.verbose;
  const targetChain = chain ?? 'ethereum';

  const emitErr = (msg, exitCode, code = 'error') => {
    if (json) {
      emit(wrapError(SCHEMA.TX, msg, { code }));
    } else {
      renderError(msg);
    }
    process.exitCode = exitCode;
  };

  // Solana sigs are 87–88 base58 chars; tightened from 80–90 to avoid collision with addresses (32–44)
  const isEvmHash = /^0x[0-9a-fA-F]{64}$/.test(txHash);
  const isSolHash = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(txHash);
  if (!isEvmHash && !isSolHash) {
    emitErr(
      `"${txHash}" does not look like a valid transaction hash. ` +
      `EVM: 0x + 64 hex chars. Solana: base58 ~88 chars.`,
      1,
    );
    return;
  }

  const isTTY = !machine && (process.stderr.isTTY ?? false);
  const spinner = isTTY
    ? createSpinner(`Decoding transaction on ${targetChain}...`)
    : null;
  if (!machine && !isTTY) printFetching(targetChain);

  const decoder = await loadDecoder();
  if (!decoder) {
    spinner?.stop();
    emitErr('Transaction decoder module is not yet available (src/decoders/index.js).', 2);
    return;
  }

  const rpcQuorum = opts.rpcQuorum ?? 'any';
  const txRaw     = !!opts.raw;

  try {
    const tx = await decoder.decodeTransaction(targetChain, txHash, { rpcQuorum, raw: txRaw });

    // ── Raw-mode short-circuit ────────────────────────────────────────────
    // Skip ENS enrichment and the normalized renderer — the whole point of
    // --raw is to emit the upstream RPC response verbatim under tx-raw/v1.
    if (tx && tx.__schema === SCHEMA.TX_RAW) {
      spinner?.stop();
      const { __schema: _s, ...rest } = tx;
      // Surface quorum divergence to TTY stderr even in raw mode. --raw forces
      // json=true, but warnings go to stderr only — safe even when stdout is JSON.
      if (rest.quorum && isDisagreement(rest.quorum)) {
        const entry = buildDisagreementEntry(targetChain, { quorum: rest.quorum, source: rest.source });
        if (entry) maybeEmitDisagreementWarnings([entry], 'transaction', { json: false, ndjson: false });
      }
      // Same for quorum degradation — stderr only, so safe even in raw/JSON mode.
      const degradedEntry = buildDegradationEntry(targetChain, rest.quorum, rpcQuorum);
      if (degradedEntry) maybeEmitDegradationWarnings([degradedEntry], 'transaction', { json: false, ndjson: false });
      // Redact URLs at the output boundary (same invariant as the non-raw path).
      if (rest.source !== undefined) rest.source = redactUrl(rest.source);
      if (rest.quorum !== undefined) rest.quorum = redactQuorumUrls(rest.quorum);
      emit(wrap(SCHEMA.TX_RAW, rest));
      return;
    }

    // Best-effort ENS reverse resolution for from/to so the renderer can
    // show "vitalik.eth" or a known contract label alongside the raw address.
    // EVM-only; never throws.
    if (tx && (tx.from || tx.to)) {
      const ensMod = await loadEnsResolver();
      if (ensMod?.reverseResolveAddress) {
        const isEvm = a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
        const [fromName, toName] = await Promise.all([
          isEvm(tx.from) ? ensMod.reverseResolveAddress(tx.from).catch(() => null) : null,
          isEvm(tx.to)   ? ensMod.reverseResolveAddress(tx.to).catch(()   => null) : null,
        ]);
        tx.fromName = fromName;
        tx.toName   = toName;
      }
    }

    // Build a balance-parity meta block when the adapter ran in a quorum mode.
    // `providers.{chain}` is the redacted winning URL; `disagreements[]` is
    // empty unless majority/all produced an actual divergence. partial=true
    // only when there IS a disagreement — single-provider success matches the
    // balance flow's behavior.
    let meta = null;
    if (tx && typeof tx === 'object' && tx.quorum) {
      const rpcMeta = {
        ok: true,
        chainsFailed: [],
        providers: tx.source ? { [targetChain]: redactUrl(tx.source) } : {},
        disagreements: [],
        degraded: [],
      };
      if (isDisagreement(tx.quorum)) {
        const entry = buildDisagreementEntry(targetChain, { quorum: tx.quorum, source: tx.source });
        if (entry) rpcMeta.disagreements.push(entry);
      }
      const degradedEntry = buildDegradationEntry(targetChain, tx.quorum, rpcQuorum);
      if (degradedEntry) rpcMeta.degraded.push(degradedEntry);
      meta = { sources: { rpc: rpcMeta } };
      if (rpcMeta.disagreements.length > 0 || rpcMeta.degraded.length > 0) meta.partial = true;
    }

    // Surface RPC disagreements to interactive users (TTY stderr only, never
    // in structured output) — same contract as the balance flow.
    maybeEmitDisagreementWarnings(meta?.sources?.rpc?.disagreements, 'transaction', { json, ndjson });
    maybeEmitDegradationWarnings(meta?.sources?.rpc?.degraded, 'transaction', { json, ndjson });

    spinner?.stop();
    if (json) {
      const { raw: _raw, quorum: _q, ...rest } = tx ?? {};
      // Redact the per-tx source URL at the output boundary so credentials in
      // user-configured RPC URLs never leak into the envelope.
      if (rest.source !== undefined) rest.source = redactUrl(rest.source);
      emit(wrap(SCHEMA.TX, { chain: targetChain, ...rest }, meta));
    } else {
      renderTransaction(tx, { verbose });
    }
  } catch (err) {
    spinner?.stop();
    emitErr(`Failed to decode transaction: ${err.message}`, 2, 'decode-failed');
  }
}

// ---------------------------------------------------------------------------
// Gas command
// ---------------------------------------------------------------------------

/**
 * Resolve the chain set for a gas query.
 * Returns null on invalid filter (caller should error).
 *
 * @param {string|null} chainFilter
 * @returns {string[]|null}
 */
function resolveGasChains(chainFilter) {
  if (!chainFilter) return [...GAS_CHAINS];
  if (!GAS_CHAINS.includes(chainFilter)) return null;
  return [chainFilter];
}

// Native price symbols needed for USD cost columns (CoinGecko ids via prices.js).
const GAS_PRICE_SYMBOLS = ['eth', 'pol', 'btc', 'sol'];

/**
 * One-shot gas command: print current gas across EVM chains.
 *
 * @param {string|null} chainFilter
 * @param {{ json?: boolean, verbose?: boolean }} [opts]
 */
export async function runGas(chainFilter, opts = {}) {
  const json = !!opts.json;
  const ndjson = !!opts.ndjson;
  const machine = json || ndjson;
  const strict = !!opts.strict;
  const emit = ndjson ? emitNDJSON : emitJSON;
  const verbose = !!opts.verbose;

  const chains = resolveGasChains(chainFilter);
  if (!chains) {
    const msg = `gas supports: ${GAS_CHAINS.join(', ')}`;
    if (json) {
      emit(wrapError(SCHEMA.GAS, msg, { code: 'unknown-chain' }));
    } else {
      renderError(msg);
    }
    process.exitCode = 1;
    return;
  }

  // Spinner suppressed under any structured-output mode — its ANSI writes to
  // stderr would interleave with downstream pipelines on shared TTYs.
  const spinner = !machine ? createMultiSpinner(chains) : null;

  const results = await getAllGas(chains, {
    onProgress: (chain, status, ms) => spinner?.update(chain, status, ms),
  });

  spinner?.stop();
  // Erase the spinner block so the gas table doesn't sit beneath it.
  if (spinner && process.stderr.isTTY) {
    process.stderr.write(`\x1b[${chains.length}A`);
    for (let i = 0; i < chains.length; i++) {
      process.stderr.write('\x1b[2K\n');
    }
    process.stderr.write(`\x1b[${chains.length}A`);
  }

  // Native prices for USD cost columns. Cached for 60s by prices.js.
  let prices = {};
  let pricesMeta = null;
  try {
    const got = await getPricesWithMeta(GAS_PRICE_SYMBOLS);
    prices = got.prices;
    pricesMeta = got.meta;
  } catch {
    // Cost column will render '—' on price failure; not fatal.
    pricesMeta = { ok: false, provider: 'coingecko', cacheAgeSec: 0, stale: false, rateLimited: false, unpriced: [] };
  }

  const gasMeta = buildGasMeta(results, pricesMeta);

  if (json) {
    emit(wrap(SCHEMA.GAS, buildGasData(results, prices), gasMeta));
  } else {
    renderGas(results, prices, { verbose });
  }

  // Exit non-zero only if every chain failed.
  if (results.every(r => r.error)) {
    process.exitCode = 2;
  } else if (strict && gasMeta.partial) {
    process.exitCode = 3;
  }
}

/**
 * Build the envelope meta block for a gas response. Aggregates per-chain RPC
 * outcome (which chains failed), the price-source meta, and a top-level
 * `partial` flag so scripted consumers can detect degraded results.
 *
 * @param {import('./gas.js').GasResult[]} results
 * @param {object|null} pricesMeta
 * @returns {object}
 */
function buildGasMeta(results, pricesMeta) {
  const chainsFailed = results.filter(r => r.error).map(r => r.chain);
  const rpcMeta = {
    ok: chainsFailed.length === 0,
    chainsFailed,
  };
  const partial =
    !rpcMeta.ok ||
    (pricesMeta && pricesMeta.ok === false);
  return {
    sources: {
      rpc: rpcMeta,
      ...(pricesMeta ? { prices: pricesMeta } : {}),
    },
    partial: !!partial,
    warnings: [],
  };
}

/**
 * Build the gas JSON data block, shared by runGas and runGasWatch.
 *
 * @param {import('./gas.js').GasResult[]} results
 * @param {Record<string, number>} prices
 * @returns {{ chains: object[], prices: Record<string, number> }}
 */
function buildGasData(results, prices) {
  return {
    prices: { ...prices },
    chains: results.map(r => ({
      chain:        r.chain,
      family:       r.family,
      nativeSymbol: r.nativeSymbol,
      isL2:         r.isL2,
      baseFeeGwei:  r.baseFeeGwei  ?? null,
      priorityGwei: r.priorityGwei ?? null,
      nextBlock:    r.nextBlock    ?? null,
      worstCase5:   r.worstCase5   ?? null,
      worstCase20:  r.worstCase20  ?? null,
      l1FeeWei:     typeof r.l1FeeWei === 'bigint' ? r.l1FeeWei.toString() : (r.l1FeeWei ?? null),
      history:      r.history      ?? [],
      bitcoin:      r.bitcoin ?? null,
      solana:       r.solana  ?? null,
      degraded:     !!r.degraded,
      error:        r.error ?? null,
    })),
  };
}

/**
 * Watch-mode gas: re-poll on an interval and re-render in place.
 * Thin loop — no snapshots, no deltas, no wallet machinery.
 *
 * @param {string|null} chainFilter
 * @param {{ json?: boolean, verbose?: boolean, interval?: number }} [opts]
 */
export async function runGasWatch(chainFilter, opts = {}) {
  const intervalSecs = typeof opts.interval === 'number' && opts.interval > 0
    ? opts.interval
    : 15;
  const verbose = !!opts.verbose;
  const json    = !!opts.json;
  const ndjson  = !!opts.ndjson;
  const machine = json || ndjson;
  const strict  = !!opts.strict;

  const chains = resolveGasChains(chainFilter);
  if (!chains) {
    const msg = `gas supports: ${GAS_CHAINS.join(', ')}`;
    if (json) {
      emitJSON(wrapError(SCHEMA.GAS_WATCH, msg, { code: 'unknown-chain' }));
    } else {
      renderError(msg);
    }
    process.exitCode = 1;
    return;
  }

  const useAltScreen = !machine && (process.stdout.isTTY ?? false);
  let altScreenActive = false;
  const enterAltScreen = () => {
    if (useAltScreen && !altScreenActive) {
      process.stdout.write('\x1b[?1049h');
      altScreenActive = true;
    }
  };
  const exitAltScreen = () => {
    if (altScreenActive) {
      process.stdout.write('\x1b[?1049l');
      altScreenActive = false;
    }
  };

  let stopped = false;
  const stopHandler = () => { stopped = true; exitAltScreen(); };
  process.on('SIGINT',  stopHandler);
  process.on('SIGTERM', stopHandler);
  process.on('SIGHUP',  stopHandler);

  let lastRefreshMs = null;
  let pollIndex = 0;

  try {
    while (!stopped) {
      const iterStart = Date.now();

      if (!machine) {
        enterAltScreen();
        // Clear within the alt buffer
        process.stdout.write('\x1b[H\x1b[2J');

        // Compact watch header
        const stopHint = c.dim('  [Ctrl+C to stop]');
        const lastStr = lastRefreshMs != null
          ? c.dim(`  last: ${(lastRefreshMs / 1000).toFixed(1)}s`)
          : '';
        console.log(
          `  ⛓ ${c.bold('GAS WATCH')}  ${c.dim(`refreshing every ${intervalSecs}s`)}${lastStr}${stopHint}`
        );
      }

      let results, prices, pricesMeta;
      try {
        const [gasRes, pricesRes] = await Promise.all([
          getAllGas(chains),
          getPricesWithMeta(GAS_PRICE_SYMBOLS).catch(() => ({
            prices: {},
            meta: { ok: false, provider: 'coingecko', cacheAgeSec: 0, stale: false, rateLimited: false, unpriced: [] },
          })),
        ]);
        results = gasRes;
        prices = pricesRes.prices;
        pricesMeta = pricesRes.meta;
      } catch (err) {
        if (json) {
          emitNDJSON(wrapEvent(SCHEMA.GAS_WATCH, 'error', {
            ok: false,
            error: { code: 'fetch-failed', message: err?.message ?? String(err) },
            poll: pollIndex++,
          }));
          if (strict) break;
        } else {
          renderError(err?.message ?? String(err));
        }
        const deadline = Date.now() + intervalSecs * 1000;
        while (Date.now() < deadline && !stopped) {
          await new Promise(r => setTimeout(r, 100));
        }
        continue;
      }

      lastRefreshMs = Date.now() - iterStart;

      if (json) {
        emitNDJSON(wrapEvent(SCHEMA.GAS_WATCH, 'poll', {
          poll: pollIndex++,
          intervalSec: intervalSecs,
          fetchMs: lastRefreshMs,
          data: buildGasData(results, prices),
          meta: buildGasMeta(results, pricesMeta),
        }));
      } else {
        renderGas(results, prices, { verbose });
      }

      if (stopped) break;

      // Poll for SIGINT every 100ms while waiting.
      const deadline = Date.now() + intervalSecs * 1000;
      while (Date.now() < deadline && !stopped) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  } finally {
    process.removeListener('SIGINT',  stopHandler);
    process.removeListener('SIGTERM', stopHandler);
    process.removeListener('SIGHUP',  stopHandler);
    exitAltScreen();
    if (json) {
      emitNDJSON(wrapEvent(SCHEMA.GAS_WATCH, 'stop', {
        reason: 'signal',
        poll: pollIndex,
      }));
    } else {
      console.log(c.dim('\nStopped.'));
    }
  }
}

// ---------------------------------------------------------------------------
// @internal — test-only named exports
// These helpers are private implementation details. Exported solely to allow
// the unit test suite to exercise them directly without instrumenting
// production code in any other way. Do not rely on these in application code.
// ---------------------------------------------------------------------------
export { maybeEmitDisagreementWarnings, formatDisagreementWarning, shortProviderName, redactQuorumUrls, __setDecoderForTest, collectDisagreementsFromWallets, collectDegradationsFromWallets, buildDegradationEntry, formatDegradationWarning, maybeEmitDegradationWarnings };
