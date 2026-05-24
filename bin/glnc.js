#!/usr/bin/env node
/**
 * bin/glnc.js
 *
 * Entrypoint for the `glnc` CLI. Runs under both Node (>=18) and Bun.
 * Parses arguments and dispatches to the appropriate command handler.
 *
 * Exit codes:
 *   0 — success
 *   1 — user/input error
 *   2 — network/upstream error (all sources failed)
 *   3 — partial result (some sources degraded) — only under --strict
 */

/**
 * Force-exit after one-shot commands complete.
 *
 * One-shot commands (balance, tx, gas, history) fully complete their work
 * before this is called, but undici's internal connection pool keeps TLS
 * sockets alive — and, critically, holds internal libuv handles that do NOT
 * appear in process._getActiveHandles() — for anywhere from 1 s to 60+ s
 * depending on whether the server sent a graceful close or we had to abort
 * a timed-out request.  The event loop therefore stays alive long after the
 * command's output has been written, causing the visible CLI hang.
 *
 * The fix for the socket lifetime is in src/chains/_evm.js (AbortController
 * per request + keepalive:false), which reduces the hang to ~11 s in the
 * worst case.  This explicit exit is the belt-and-suspenders guarantee that
 * the process never outlives its useful work regardless of undici internals.
 *
 * stdout is drained first: the empty write's callback fires only after all
 * previously queued bytes have been handed off to the OS, so consumers that
 * pipeline `glnc … | jq` always receive complete output.
 *
 * Never called from watch, interactive, or alert — those are long-running
 * loops that must not exit early.
 */
function forceExit() {
  const code = process.exitCode ?? 0;
  // The empty-string write enqueues a no-op behind any pending output bytes;
  // its callback fires once the write queue is fully drained.
  process.stdout.write('', () => process.exit(code));
}

import { parseArgs, ParseError } from '../src/cli/args.js';
import { renderHelp, renderCommandHelp, renderVersion, renderError } from '../src/cli/render.js';
import { runBalance, runTx, runWatch, runGas, runGasWatch, runAlert, runHistory } from '../src/index.js';
import { runInteractive } from '../src/cli/interactive.js';
import { ALL_SCHEMAS } from '../src/output/schemas.js';
// Static JSON import so the version is embedded into both the Bun-compiled
// single-file binary and the Node ESM runtime. Requires Node >=20.10 (see
// "engines" in package.json) and is natively supported by `bun --compile`.
import pkg from '../package.json' with { type: 'json' };

const version = pkg.version;

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  if (err instanceof ParseError) {
    renderError(err.message);
    process.exit(1);
  }
  throw err;
}

switch (args.command) {
  case 'help':
    if (args.helpFor && renderCommandHelp(args.helpFor)) {
      process.exit(0);
    }
    renderHelp(version);
    process.exit(0);
    break;

  case 'version':
    renderVersion(version);
    process.exit(0);
    break;

  case 'balance':
    if (args.watch) {
      // Long-running loop — must NOT call forceExit().
      await runWatch(args.addresses, args.chain, {
        json: args.json,
        ndjson: args.ndjson,
        strict: args.strict,
        verbose: args.verbose,
        interval: args.interval,
        positions: args.positions,
        nfts: args.nfts,
        rpcQuorum: args.rpcQuorum,
      });
    } else {
      await runBalance(args.addresses, args.chain, {
        json: args.json,
        ndjson: args.ndjson,
        strict: args.strict,
        verbose: args.verbose,
        positions: args.positions,
        nfts: args.nfts,
        rpcQuorum: args.rpcQuorum,
      });
      forceExit();
    }
    break;

  case 'tx':
    await runTx(args.txHash, args.chain, {
      json: args.json,
      ndjson: args.ndjson,
      verbose: args.verbose,
      rpcQuorum: args.rpcQuorum,
      raw: args.txRaw,
    });
    forceExit();
    break;

  case 'gas':
    if (args.watch) {
      // Long-running loop — must NOT call forceExit().
      await runGasWatch(args.chain, {
        json: args.json,
        ndjson: args.ndjson,
        strict: args.strict,
        verbose: args.verbose,
        interval: args.interval,
      });
    } else {
      await runGas(args.chain, {
        json: args.json,
        ndjson: args.ndjson,
        strict: args.strict,
        verbose: args.verbose,
      });
      forceExit();
    }
    break;

  case 'interactive':
    // Long-running TUI — must NOT call forceExit().
    await runInteractive(version);
    break;

  case 'history':
    await runHistory(args.address, {
      chain: args.chain,
      from: args.fromDate,
      to: args.toDate,
      out: args.outPath,
      apiKey: args.apiKey,
      noPrices: args.noPrices,
      costBasis: args.costBasis,
      ownWallets: args.ownWallets,
      json: args.json,
      ndjson: args.ndjson,
      verbose: args.verbose,
    });
    forceExit();
    break;

  case 'alert':
    // Long-running daemon loop — must NOT call forceExit().
    await runAlert(args.address, {
      condition: args.condition,
      webhook: args.webhook,
      interval: args.interval,
      chain: args.chain,
      once: args.once,
      rpc: args.rpc,
      json: args.json,
      verbose: args.verbose,
      dryRun: args.dryRun,
    });
    break;

  case 'schema':
    // List schema ids for shell scripts that want to validate output streams.
    if (args.addresses.length === 0) {
      for (const s of ALL_SCHEMAS) process.stdout.write(s + '\n');
    } else {
      const want = args.addresses[0];
      // Accept full id ("glnc.balance/v1"), prefix ("glnc.balance"), or short
      // alias ("balance", "balance.watch", "tx", ...).
      const match = ALL_SCHEMAS.find(s =>
        s === want ||
        s.startsWith(want + '/') ||
        s === `glnc.${want}` ||
        s.startsWith(`glnc.${want}/`)
      );
      if (!match) {
        renderError(`Unknown schema "${want}". Run "glnc schema" for the full list.`);
        process.exit(1);
      }
      process.stdout.write(match + '\n');
    }
    process.exit(0);
    break;

  default:
    renderError(`Unhandled command: "${args.command}". Run "glnc --help" for usage.`);
    process.exit(1);
}
