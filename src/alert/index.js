/**
 * src/alert/index.js
 *
 * Orchestrates the `glnc alert` command: resolves address, fetches chain state,
 * evaluates a condition DSL expression, and POSTs to a webhook on a true edge.
 * Persists last-fired state to avoid spamming the webhook on consecutive polls.
 */

import { parseCondition, evaluateCondition, buildContext } from './conditions.js';
import { postWebhook } from './webhook.js';
import { readAlertState, writeAlertState } from './state.js';
import { getPrices } from '../prices.js';
import { getAavePositions } from '../positions/aave.js';
import { detectChains } from '../index.js';
import { BALANCE_SUPPORTED_CHAINS } from '../cli/args.js';
import { c } from '../cli/render.js';
import { wrapEvent, wrapError } from '../output/envelope.js';
import { emitNDJSON } from '../output/emit.js';
import { SCHEMA } from '../output/schemas.js';

// ---------------------------------------------------------------------------
// Lazy loaders (mirror src/index.js pattern)
// ---------------------------------------------------------------------------

async function loadEnsResolver() {
  try {
    return await import('../resolvers/ens.js');
  } catch {
    return null;
  }
}

async function loadChainAdapter(chain) {
  // Static dispatch: bun build --compile cannot include modules referenced
  // only via template dynamic imports. Mirror src/index.js loadChainAdapter.
  try {
    switch (chain) {
      case 'ethereum': return await import('../chains/ethereum.js');
      case 'polygon':  return await import('../chains/polygon.js');
      case 'arbitrum': return await import('../chains/arbitrum.js');
      case 'base':     return await import('../chains/base.js');
      case 'optimism': return await import('../chains/optimism.js');
      case 'linea':    return await import('../chains/linea.js');
      case 'zksync':   return await import('../chains/zksync.js');
      case 'solana':   return await import('../chains/solana.js');
      case 'bitcoin':  return await import('../chains/bitcoin.js');
      default:         return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Address shortener (inline — mirrors formatAddress in render.js)
// ---------------------------------------------------------------------------

/**
 * Shorten an address for non-verbose display.
 * EVM/BTC: first 6 + … + last 4. Solana: first 4 + … + last 4.
 *
 * @param {string} addr
 * @param {boolean} verbose
 * @returns {string}
 */
function shortenAddress(addr, verbose) {
  if (!addr) return '—';
  if (verbose) return addr;
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  if (isSolana) return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// ENS resolution — falls through to raw input on failure
// ---------------------------------------------------------------------------

/**
 * @param {string} input
 * @returns {Promise<{ resolvedAddress: string, displayName: string|null }>}
 */
async function resolveInput(input) {
  const ensMod = await loadEnsResolver();
  if (ensMod) {
    try {
      const r = await ensMod.resolveAddress(input);
      if (r.address !== null) {
        return { resolvedAddress: r.address, displayName: r.displayName ?? null };
      }
    } catch {
      // fall through
    }
  }
  return { resolvedAddress: input, displayName: null };
}

// ---------------------------------------------------------------------------
// Determine which symbol(s) need a price lookup for the condition
// ---------------------------------------------------------------------------

/**
 * @param {import('./conditions.js').ParsedCondition} parsed
 * @returns {string[]}  — uppercase symbols to pass to getPrices
 */
function symbolsForCondition(parsed) {
  const { lhs } = parsed;
  // balance.<symbol>.usd needs a price; balance.<symbol> does not
  if (lhs[0] === 'balance' && lhs[2] === 'usd') {
    return [lhs[1].toUpperCase()];
  }
  return [];
}

// ---------------------------------------------------------------------------
// One poll iteration
// ---------------------------------------------------------------------------

/**
 * Execute a single poll: fetch state, evaluate condition, maybe fire webhook.
 *
 * @param {string} rawAddress
 * @param {{
 *   condition: string,
 *   webhook: string,
 *   chain: string|null,
 *   verbose: boolean,
 *   dryRun: boolean,
 *   rpc: string|null,
 *   json: boolean,
 *   pollIndex: number,
 *   parsedCondition: import('./conditions.js').ParsedCondition,
 * }} opts
 * @returns {Promise<{ exitCode: number }>}
 */
async function runIteration(rawAddress, opts) {
  const { condition, webhook, verbose, dryRun, parsedCondition } = opts;
  const json = !!opts.json;
  const pollIndex = opts.pollIndex ?? 0;

  const emitErr = (code, msg) => {
    if (json) {
      emitNDJSON(wrapEvent(SCHEMA.ALERT, 'error', {
        ok: false,
        poll: pollIndex,
        condition,
        error: { code, message: msg },
      }));
    } else {
      process.stderr.write(c.red('Error:') + ` ${msg}\n`);
    }
  };

  // 1. Resolve address
  const { resolvedAddress, displayName } = await resolveInput(rawAddress);

  // 2. Determine chain
  let chain = opts.chain;
  if (!chain) {
    const detected = detectChains(resolvedAddress);
    // For EVM addresses auto-detect returns multiple chains; require --chain
    if (detected.length > 1) {
      emitErr('ambiguous-chain',
        `Auto-detected ${detected.length} chains for this address. ` +
        `Use --chain to specify (e.g. --chain eth).`);
      return { exitCode: 1 };
    }
    if (detected.length === 0) {
      emitErr('unknown-chain', `Could not detect chain for address "${resolvedAddress}".`);
      return { exitCode: 1 };
    }
    chain = detected[0];
  }

  // 3. Fetch balance (always) + Aave (if condition references it)
  const needsAave = parsedCondition.lhs[0] === 'aave';
  const adapter = await loadChainAdapter(chain);
  if (!adapter) {
    emitErr('no-adapter', `No chain adapter found for "${chain}".`);
    return { exitCode: 2 };
  }
  if (!BALANCE_SUPPORTED_CHAINS.includes(chain)) {
    emitErr('unsupported-chain',
      `alert is not supported on "${chain}". ` +
      `Supported: ${BALANCE_SUPPORTED_CHAINS.join(', ')}.`);
    return { exitCode: 2 };
  }

  let balanceResult = null;
  let aaveResult = null;
  try {
    const tasks = [adapter.getBalances(resolvedAddress)];
    if (needsAave) {
      tasks.push(getAavePositions(resolvedAddress, chain));
    }
    const [bal, aave] = await Promise.all(tasks);
    balanceResult = bal;
    aaveResult = aave ?? null;
  } catch (err) {
    emitErr('fetch-failed', `Chain fetch failed: ${err?.message ?? err}`);
    return { exitCode: 2 };
  }

  // 4. Fetch prices if needed
  let prices = {};
  const syms = symbolsForCondition(parsedCondition);
  if (syms.length > 0) {
    try {
      prices = await getPrices(syms);
    } catch {
      // Non-fatal; condition will evaluate to null → false
    }
  }

  // 5. Build context and evaluate
  const ctx = buildContext({ balanceResult, aaveResult, prices });
  const evalResult = evaluateCondition(parsedCondition, ctx);

  // 6. Dry-run: print result and skip webhook
  const ts = new Date().toISOString();
  const addrDisplay = displayName
    ? `${displayName} (${shortenAddress(resolvedAddress, verbose)})`
    : shortenAddress(resolvedAddress, verbose);

  if (dryRun) {
    if (json) {
      emitNDJSON(wrapEvent(SCHEMA.ALERT, 'evaluated', {
        poll: pollIndex,
        address: resolvedAddress,
        displayName,
        chain,
        condition,
        lhsValue: evalResult.lhsValue,
        conditionTrue: evalResult.ok,
        dryRun: true,
        fired: false,
      }));
    } else {
      const statusStr = evalResult.ok ? c.green('TRUE') : c.red('FALSE');
      process.stdout.write(
        `${c.dim(ts)}  ${c.bold(addrDisplay)}  ` +
        `${c.dim(condition)}  lhs=${evalResult.lhsValue ?? 'null'}  ` +
        `${statusStr}  ${c.dim('[dry-run]')}\n`
      );
    }
    return { exitCode: 0 };
  }

  // 7. Read persisted state
  const alertKey = `${resolvedAddress.toLowerCase()}:${condition}`;
  const prevState = await readAlertState(alertKey);

  // Determine if we should fire
  // Fire when condition is true AND (no prior state OR last result was false)
  const shouldFire = evalResult.ok && (prevState === null || !prevState.lastConditionResult);

  let firedStr = c.dim('not-fired');
  let outcome = 'not-fired';      // for JSON event
  let httpStatus = null;
  let webhookErr = null;

  if (evalResult.ok && prevState?.lastConditionResult === true) {
    // Condition still true but already fired — skip (state-deduped)
    firedStr = c.dim('skipped(deduped)');
    outcome = 'deduped';
  } else if (shouldFire) {
    // Build webhook payload
    const snapshot = {
      native: balanceResult?.native ?? null,
      tokens: balanceResult?.tokens ?? [],
      ...(aaveResult?.hasPosition ? { aave: aaveResult } : {}),
    };

    const payload = {
      alert: {
        address: verbose ? resolvedAddress : shortenAddress(resolvedAddress, false),
        displayName: displayName ?? null,
        chain,
        condition,
        lhsValue: evalResult.lhsValue,
        evaluatedAt: ts,
        snapshot,
      },
    };

    const webhookResult = await postWebhook(webhook, payload);
    if (webhookResult.ok) {
      await writeAlertState(alertKey, {
        lastFiredAt: Date.now(),
        lastConditionResult: true,
      });
      firedStr = c.green(`fired (HTTP ${webhookResult.status})`);
      outcome = 'fired';
      httpStatus = webhookResult.status;
    } else {
      if (!json) {
        process.stderr.write(
          c.red('Webhook error:') + ` ${webhookResult.error} after ${webhookResult.attempts} attempts\n`
        );
      }
      firedStr = c.red(`fire-failed: ${webhookResult.error}`);
      outcome = 'fire-failed';
      webhookErr = webhookResult.error;
    }
  } else if (!evalResult.ok) {
    // Condition false — re-arm state
    await writeAlertState(alertKey, {
      lastFiredAt: prevState?.lastFiredAt ?? 0,
      lastConditionResult: false,
    });
  }

  if (json) {
    emitNDJSON(wrapEvent(SCHEMA.ALERT, 'evaluated', {
      poll: pollIndex,
      address: resolvedAddress,
      displayName,
      chain,
      condition,
      lhsValue: evalResult.lhsValue,
      conditionTrue: evalResult.ok,
      dryRun: false,
      outcome,
      httpStatus,
      webhookError: webhookErr,
      fired: outcome === 'fired',
    }));
  } else {
    const conditionColor = evalResult.ok ? c.green : c.red;
    process.stdout.write(
      `${c.dim(ts)}  ${c.bold(addrDisplay)}  ` +
      `${conditionColor(condition)}  lhs=${evalResult.lhsValue ?? 'null'}  ` +
      `${firedStr}\n`
    );
  }

  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the alert command — one shot or looping.
 *
 * @param {string} address
 * @param {{
 *   condition: string,
 *   webhook: string,
 *   interval: number,
 *   chain: string|null,
 *   once: boolean,
 *   rpc: string|null,
 *   verbose: boolean,
 *   dryRun: boolean,
 * }} opts
 * @returns {Promise<void>}
 */
export async function runAlert(address, opts) {
  const {
    condition,
    webhook,
    interval = 120,
    chain = null,
    once = false,
    rpc = null,
    verbose = false,
    dryRun = false,
    json = false,
  } = opts;

  // Warn if rpc is provided — not yet plumbed into adapters
  if (rpc) {
    process.stderr.write(
      c.dim('Warning: --rpc override is not yet supported by chain adapters; flag ignored.\n')
    );
  }

  // Parse condition once — fail fast before any I/O
  let parsedCondition;
  try {
    parsedCondition = parseCondition(condition);
  } catch (err) {
    if (json) {
      emitNDJSON(wrapError(SCHEMA.ALERT, err.message, { code: 'parse-error' }));
    } else {
      process.stderr.write(c.red('Error:') + ` ${err.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  let pollIndex = 0;
  const iterOpts = () => ({
    condition, webhook, chain, verbose, dryRun, rpc, json, parsedCondition,
    pollIndex: pollIndex++,
  });

  if (once) {
    const { exitCode } = await runIteration(address, iterOpts()).catch(err => {
      if (json) {
        emitNDJSON(wrapEvent(SCHEMA.ALERT, 'error', {
          ok: false,
          error: { code: 'fatal', message: err?.message ?? String(err) },
        }));
      } else {
        process.stderr.write(c.red('Fatal:') + ` ${err?.message ?? err}\n`);
      }
      return { exitCode: 1 };
    });
    process.exitCode = exitCode;
    return;
  }

  // Loop mode
  let stopped = false;
  const sigintHandler = () => { stopped = true; };
  process.on('SIGINT', sigintHandler);

  try {
    while (!stopped) {
      try {
        await runIteration(address, iterOpts());
      } catch (err) {
        // Never crash the loop
        if (json) {
          emitNDJSON(wrapEvent(SCHEMA.ALERT, 'error', {
            ok: false,
            error: { code: 'iteration-error', message: err?.message ?? String(err) },
          }));
        } else {
          process.stderr.write(c.red('Error in iteration:') + ` ${err?.message ?? err}\n`);
        }
      }

      if (stopped || once) break;

      // Wait interval seconds, polling for SIGINT every 100ms
      const deadline = Date.now() + interval * 1000;
      while (Date.now() < deadline && !stopped) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    if (json) {
      emitNDJSON(wrapEvent(SCHEMA.ALERT, 'stop', {
        reason: 'sigint',
        poll: pollIndex,
      }));
    } else {
      console.log(c.dim('Stopped.'));
    }
  }
}
