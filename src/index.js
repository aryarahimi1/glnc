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
 */

import { getPrices } from './prices.js';
import { readSnapshot, writeSnapshot } from './snapshots.js';
import { wrap, wrapError, wrapEvent } from './output/envelope.js';
import { emitJSON, emitNDJSON } from './output/emit.js';
import { SCHEMA } from './output/schemas.js';

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

// ---------------------------------------------------------------------------
// Address type detection
// ---------------------------------------------------------------------------

const EVM_CHAINS = ['ethereum', 'polygon', 'arbitrum', 'base'];

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
    return EVM_CHAINS;
  }

  // Bitcoin bech32 (native SegWit): bc1...
  if (/^bc1[ac-hj-np-z02-9]{6,87}$/i.test(address)) {
    return ['bitcoin'];
  }

  // Bitcoin legacy P2PKH (starts with 1) or P2SH (starts with 3)
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
    return ['bitcoin'];
  }

  // Solana: base58 string, 32–44 chars, no 0x prefix
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return ['solana'];
  }

  return [];
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
async function loadDecoder() {
  try {
    return await import('./decoders/index.js');
  } catch {
    return null;
  }
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
        const result = await adapter.getBalances(resolvedAddress);
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
        positionsResult = await posMod
          .getPositions(resolvedAddress, evmChains)
          .catch(() => null);
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
        nftsResult = await nftMod
          .getNftHoldings(resolvedAddress, evmNftChains, {
            apiKey: process.env.RESERVOIR_API_KEY ?? null,
          })
          .catch(() => null);
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
 * Fetch balances for one or more addresses.
 * Handles ENS resolution, multi-wallet concurrency, price fetching,
 * and dust filtering. Does NOT render anything.
 *
 * @param {string | string[]} addressInput
 * @param {string|null} chainFilter
 * @param {{ json?: boolean, verbose?: boolean, positions?: boolean }} opts
 * @returns {Promise<{ wallets: WalletResult[], prices: Record<string, number> }>}
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
  if (symbols.size > 0) {
    try {
      prices = await getPrices([...symbols]);
    } catch {
      // Non-fatal — render without USD values
    }
  }

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
          entry.result.tokens = filterDust(tokens, prices);
        } catch {
          // Non-fatal
        }
      }
    }
  }

  return { wallets, prices };
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
  const verbose = !!opts.verbose;

  // Normalise to array
  const addrArray = Array.isArray(addresses) ? addresses : [addresses];

  // Validate that we have at least one address
  if (addrArray.length === 0) {
    const msg = 'Usage: glnc balance <address> [address2 ...] [--chain <name>]';
    if (json) {
      emitJSON(wrapError(SCHEMA.BALANCE, msg, { code: 'usage' }));
    } else {
      renderError(msg);
    }
    process.exitCode = 1;
    return;
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
      const msg =
        `Could not detect chain for address: ${addrArray[0]}. ` +
        `Use --chain <name> to specify (ethereum, polygon, solana, bitcoin, arbitrum, base).`;
      if (json) {
        emitJSON(wrapError(SCHEMA.BALANCE, msg, { code: 'unknown-chain' }));
      } else {
        renderError(msg);
      }
      process.exitCode = 1;
      return;
    }
  }

  const { wallets, prices } = await fetchBalances(addrArray, chainFilter, opts);

  const multiWallet = addrArray.length > 1;

  if (json) {
    // JSON mode: emit all wallets in a single envelope
    emitJSON(wrap(SCHEMA.BALANCE, buildBalanceData(wallets, prices)));
    return;
  }

  // Pretty rendering
  if (multiWallet) {
    for (const wallet of wallets) {
      renderWalletHeader(wallet.displayName, wallet.resolvedAddress, { verbose });
      renderBalances(wallet.results, prices, {
        verbose,
        positions: wallet.positions,
        nfts: wallet.nfts,
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
    });
  }

  // If every chain of every wallet errored, signal network failure
  const allFailed = wallets.every(w =>
    w.results.length === 0 || w.results.every(r => r.error || r.result?.error)
  );
  if (allFailed && wallets.length > 0) {
    process.exitCode = 2;
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

  // Handle SIGINT cleanly — exit alt-screen so the user's scrollback is
  // restored before we surrender the foreground.
  const sigintHandler = () => {
    stopped = true;
    exitAltScreen();
  };
  process.on('SIGINT', sigintHandler);

  let lastRefreshMs = null;
  let prevPollData = null;
  let pollIndex = 0;

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
      let wallets, prices;
      try {
        ({ wallets, prices } = await fetchBalances(addrArray, chainFilter, opts));
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
        }));
        prevPollData = data;
      } else {
        const multiWallet = addrArray.length > 1;
        if (multiWallet) {
          for (const wallet of wallets) {
            renderWalletHeader(wallet.displayName, wallet.resolvedAddress, { verbose });
            renderBalances(wallet.results, prices, {
              verbose,
              positions: wallet.positions,
              nfts: wallet.nfts,
              deltas: walletDeltas.get(wallet.resolvedAddress),
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
            });
          }
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
    process.removeListener('SIGINT', sigintHandler);
    exitAltScreen();
    if (json) {
      emitNDJSON(wrapEvent(SCHEMA.BALANCE_WATCH, 'stop', {
        reason: 'sigint',
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
    return {
      address: wallet.resolvedAddress,
      displayName: wallet.displayName,
      chains: chainsOut.chains,
      grandTotalUsd: chainsOut.grandTotalUsd,
      nfts: wallet.nfts ?? null,
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

    return {
      chain,
      error: null,
      assets,
      totalUsd: chainTotalKnown ? chainTotalUsd : null,
    };
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
  const verbose = !!opts.verbose;
  const targetChain = chain ?? 'ethereum';

  const emitErr = (msg, exitCode, code = 'error') => {
    if (json) {
      emitJSON(wrapError(SCHEMA.TX, msg, { code }));
    } else {
      renderError(msg);
    }
    process.exitCode = exitCode;
  };

  // Validate hash looks plausible (EVM: 0x + 64 hex; Solana: base58 ~88 chars)
  const isEvmHash = /^0x[0-9a-fA-F]{64}$/.test(txHash);
  const isSolHash = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(txHash);
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

  try {
    const tx = await decoder.decodeTransaction(targetChain, txHash);

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

    spinner?.stop();
    if (json) {
      const { raw: _raw, ...rest } = tx ?? {};
      emitJSON(wrap(SCHEMA.TX, { chain: targetChain, ...rest }));
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
  const verbose = !!opts.verbose;

  const chains = resolveGasChains(chainFilter);
  if (!chains) {
    const msg = `gas supports: ${GAS_CHAINS.join(', ')}`;
    if (json) {
      emitJSON(wrapError(SCHEMA.GAS, msg, { code: 'unknown-chain' }));
    } else {
      renderError(msg);
    }
    process.exit(1);
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
  try {
    prices = await getPrices(GAS_PRICE_SYMBOLS);
  } catch {
    // Cost column will render '—' on price failure; not fatal.
  }

  if (json) {
    emitJSON(wrap(SCHEMA.GAS, buildGasData(results, prices)));
  } else {
    renderGas(results, prices, { verbose });
  }

  // Exit non-zero only if every chain failed.
  if (results.every(r => r.error)) {
    process.exit(2);
  }
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
      blocks5:      r.blocks5      ?? null,
      blocks20:     r.blocks20     ?? null,
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
    process.exit(1);
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
  const sigintHandler = () => { stopped = true; exitAltScreen(); };
  process.on('SIGINT', sigintHandler);

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

      let results, prices;
      try {
        [results, prices] = await Promise.all([
          getAllGas(chains),
          getPrices(GAS_PRICE_SYMBOLS).catch(() => ({})),
        ]);
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
    process.removeListener('SIGINT', sigintHandler);
    exitAltScreen();
    if (json) {
      emitNDJSON(wrapEvent(SCHEMA.GAS_WATCH, 'stop', {
        reason: 'sigint',
        poll: pollIndex,
      }));
    } else {
      console.log(c.dim('\nStopped.'));
    }
  }
}
