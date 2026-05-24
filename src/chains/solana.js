/**
 * src/chains/solana.js
 *
 * Solana Mainnet chain adapter using the public JSON-RPC endpoint.
 * Uses fetch directly (no Solana SDK needed).
 *
 * For quorum modes 'majority' and 'all', a self-contained parallel quorum
 * helper (solanaQuorum) is used instead of the EVM queryQuorum, because
 * queryQuorum builds viem clients internally and Solana uses raw fetch.
 * The logic mirrors queryQuorum exactly (v1.2.0 streaming early-exit
 * algorithm with per-URL AbortController teardown) — it is not a fork, just a
 * URL-based variant of the same algorithm.
 *
 * Exports:
 *   name          — 'solana'
 *   RPC_URLS      — string[]
 *   getBalances({ address, rpcQuorum? })
 *   getTransaction({ signature, rpcQuorum? })  — signature is a base58 tx sig
 */

import { RpcDisagreementError, MAX_QUORUM_FANOUT } from './_evm.js';

export const name = 'solana';

// Curated 2026-05 against live availability; no API key required.
// Solana's free-public-RPC landscape is sparse — only 2 viable endpoints exist
// without an API key. publicnode and blastapi were removed (broken TLS / dead DNS).
export const RPC_URLS = [
  'https://solana.lava.build',
  'https://api.mainnet-beta.solana.com',
];

// Lamports per SOL
const LAMPORTS_PER_SOL = 1_000_000_000n;

// Known SPL token mint → metadata mapping for display
// Accounts returned by getTokenAccountsByOwner already have balance + decimals
// from the token account data, but we enrich symbol via this lookup.
const KNOWN_MINTS = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC',  decimals: 6  },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT',  decimals: 6  },
  'So11111111111111111111111111111111111111112':   { symbol: 'WSOL',  decimals: 9  },
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { symbol: 'WETH',  decimals: 8  },
  '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E': { symbol: 'WBTC',  decimals: 6  },
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So':  { symbol: 'mSOL',  decimals: 9  },
};

// ─── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Format lamports as a decimal SOL string.
 */
function formatSol(lamports) {
  const big = BigInt(lamports);
  const whole = big / LAMPORTS_PER_SOL;
  const frac = big % LAMPORTS_PER_SOL;
  return `${whole}.${frac.toString().padStart(9, '0')}`;
}

/**
 * Format a raw SPL token amount using its decimals.
 */
function formatSpl(amount, decimals) {
  const big = BigInt(amount);
  if (decimals === 0) return big.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = big / divisor;
  const frac = big % divisor;
  return `${whole}.${frac.toString().padStart(decimals, '0')}`;
}

// ─── Solana parallel quorum ───────────────────────────────────────────────────

// Per-URL timeout for the parallel (majority/all) paths.
const SOLANA_TIMEOUT_MS = 12_000;

/**
 * Strip credentials from a URL for error messages.
 *
 * @param {string} u
 * @returns {string}
 */
function redactUrl(u) {
  try {
    const url = new URL(u);
    url.username = '';
    url.password = '';
    url.search   = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Parallel quorum for Solana JSON-RPC.
 *
 * Mirrors queryQuorum's streaming early-exit algorithm exactly, but operates
 * directly on URL strings rather than viem clients.
 *
 * Calling shape — supports BOTH:
 *   solanaQuorum(mode, execFn, normalizeFn)                      // legacy positional
 *   solanaQuorum({ mode, exec, normalize, urls?, timeoutMs? })   // EVM-parity object
 *
 * `execFn(url, signal)` — the second arg is an AbortSignal that fires the
 * moment quorum decides to abandon this URL (timeout, peer consensus reached,
 * or fail-fast). exec callers that pass it to fetch() get socket teardown for
 * free; older callers that ignore it still work — they just lose the
 * undici-socket-pool hang fix on that path.
 *
 * @param {'any'|'majority'|'all'|object} modeOrOpts
 * @param {(url: string, signal?: AbortSignal) => Promise<*>} [execFnArg]
 * @param {(v: *) => string} [normalizeFnArg]
 * @returns {Promise<{ value: *, source: string, agreement: string, disagreements: Array<*>, sources: Array<*>, mode: string }>}
 */
async function solanaQuorum(modeOrOpts, execFnArg, normalizeFnArg) {
  // Normalize the two calling shapes into a single options bag.
  const opts = typeof modeOrOpts === 'object' && modeOrOpts !== null
    ? modeOrOpts
    : { mode: modeOrOpts, exec: execFnArg, normalize: normalizeFnArg };

  const mode      = opts.mode ?? 'any';
  const execFn    = opts.exec;
  const urls      = opts.urls ?? RPC_URLS;
  const timeoutMs = opts.timeoutMs ?? SOLANA_TIMEOUT_MS;
  const normalizer = opts.normalize ?? ((v) => String(v));

  if (urls.length > MAX_QUORUM_FANOUT || urls.length < 1) {
    throw new Error(
      `solanaQuorum: urls.length must be between 1 and ${MAX_QUORUM_FANOUT}`,
    );
  }

  /**
   * Wrap a single execFn(url) with per-URL timeout + AbortController.
   *
   * The AbortSignal is passed as execFn's second arg so callers that wire it
   * into fetch() get immediate socket teardown when quorum decides to abandon.
   * On settle we both clearTimeout and controller.abort() so any other code
   * path honoring the signal benefits, mirroring _evm.js execWithTimeout().
   */
  function execWithTimeout(url) {
    const controller = new AbortController();
    let timerHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timerHandle = setTimeout(
        () => reject(new Error(`timeout after ${timeoutMs}ms querying ${redactUrl(url)}`)),
        timeoutMs,
      );
    });

    return Promise.race([execFn(url, controller.signal), timeoutPromise]).then(
      (value) => {
        clearTimeout(timerHandle);
        controller.abort();
        const normalizedKey = normalizer(value);
        if (
          normalizedKey === '[object Object]' &&
          typeof value === 'object' &&
          value !== null
        ) {
          const err = new Error(
            'solanaQuorum: object value requires explicit normalize() — default String(v) collapses all objects to "[object Object]"',
          );
          err.isDeveloperError = true;
          throw err;
        }
        return { url, status: 'fulfilled', value, normalizedKey };
      },
      (err) => {
        clearTimeout(timerHandle);
        controller.abort();
        if (err && err.isDeveloperError) throw err;
        return { url, status: 'rejected', error: err?.message ?? String(err) };
      },
    );
  }

  // ── mode: 'any' — sequential first-success ───────────────────────────────
  // Matches EVM queryQuorum's rationale: avoid tripling load on rate-limited
  // free-tier RPCs. Try each URL in order; return on first success.
  if (mode === 'any') {
    const sources = [];
    const errors = [];
    let winnerSlot = null;

    for (const url of urls) {
      const slot = await execWithTimeout(url);
      sources.push(slot);
      if (slot.status === 'fulfilled') {
        winnerSlot = slot;
        break;
      }
      errors.push(`${redactUrl(slot.url)}: ${slot.error ?? 'unknown'}`);
    }

    if (winnerSlot === null) {
      throw new Error('all Solana RPCs failed: ' + errors.join('; '));
    }

    // Untried URLs (after the winner) get 'not-tried' so callers can tell
    // "we tried and it failed" from "we never made a request".
    const triedUrls = new Set(sources.map((s) => s.url));
    for (const url of urls) {
      if (!triedUrls.has(url)) {
        sources.push({ url, status: 'rejected', error: 'not-tried' });
      }
    }

    return {
      value: winnerSlot.value,
      source: winnerSlot.url,
      sources,
      agreement: 'single',
      disagreements: [],
      mode: 'any',
    };
  }

  // ── mode: 'majority' | 'all' — streaming early-exit ──────────────────────
  //
  // See _evm.js queryQuorum() for the full algorithm rationale. Summary:
  //   majority — return as soon as ⌊N/2⌋+1 responses agree on one key, OR
  //              as soon as that threshold becomes mathematically unreachable
  //              (fall to plurality), OR the leader becomes undethronable.
  //   all      — fail fast (throw RpcDisagreementError) the moment a second
  //              distinct key appears.
  // Abandoned in-flight URLs are aborted and recorded as
  // { status: 'rejected', error: 'aborted' }.

  const totalUrls = urls.length;
  const majorityThreshold = Math.floor(totalUrls / 2) + 1;

  /** @type {Array<{idx:number, url:string, promise:Promise<*>, abort:()=>void}>} */
  const inflightEntries = urls.map((url, idx) => {
    const controller = new AbortController();
    let timerHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timerHandle = setTimeout(
        () => reject(new Error(`timeout after ${timeoutMs}ms querying ${redactUrl(url)}`)),
        timeoutMs,
      );
    });

    const promise = Promise.race([execFn(url, controller.signal), timeoutPromise]).then(
      (value) => {
        clearTimeout(timerHandle);
        controller.abort();
        const normalizedKey = normalizer(value);
        if (
          normalizedKey === '[object Object]' &&
          typeof value === 'object' &&
          value !== null
        ) {
          const err = new Error(
            'solanaQuorum: object value requires explicit normalize() — default String(v) collapses all objects to "[object Object]"',
          );
          err.isDeveloperError = true;
          throw err;
        }
        return { idx, url, status: 'fulfilled', value, normalizedKey };
      },
      (err) => {
        clearTimeout(timerHandle);
        controller.abort();
        if (err && err.isDeveloperError) throw err;
        return { idx, url, status: 'rejected', error: err?.message ?? String(err) };
      },
    );

    return {
      idx,
      url,
      promise,
      abort: () => { clearTimeout(timerHandle); controller.abort(); },
    };
  });

  const entryByIdx = new Map(inflightEntries.map((e) => [e.idx, e]));
  const pendingIndices = new Set(inflightEntries.map((e) => e.idx));

  /** @type {Array<{url:string, status:'fulfilled'|'rejected', value?:*, normalizedKey?:string, error?:string}>} */
  const sources = [];
  /** @type {Map<string, Array<{url:string,status:'fulfilled',value:*,normalizedKey:string}>>} */
  const groups = new Map();
  /** @type {Array<{url:string,status:'fulfilled',value:*,normalizedKey:string}>} */
  const fulfilled = [];

  function abortAndDrainPending() {
    for (const idx of pendingIndices) {
      const entry = entryByIdx.get(idx);
      if (entry) {
        entry.abort();
        sources.push({ url: entry.url, status: 'rejected', error: 'aborted' });
      }
    }
    pendingIndices.clear();
  }

  while (pendingIndices.size > 0) {
    const racePromises = [...pendingIndices].map((idx) => entryByIdx.get(idx).promise);
    const slot = await Promise.race(racePromises);

    pendingIndices.delete(slot.idx);

    if (slot.isDeveloperError) throw slot;

    const { idx: _idx, ...publicSlot } = slot;
    sources.push(publicSlot);

    if (slot.status === 'fulfilled') {
      fulfilled.push(publicSlot);
      const key = slot.normalizedKey;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(publicSlot);

      if (mode === 'all') {
        if (groups.size > 1) {
          abortAndDrainPending();
          throw new RpcDisagreementError({
            urls,
            values: fulfilled.map((s) => ({ url: s.url, normalizedKey: s.normalizedKey, value: s.value })),
          });
        }
      } else {
        // mode === 'majority'
        const groupSize = groups.get(key).length;
        if (groupSize >= majorityThreshold) {
          abortAndDrainPending();
          const winnerSlot = groups.get(key)[0];
          const losingMembers = fulfilled.filter((s) => s.normalizedKey !== key);
          const earlyAgreement = losingMembers.length > 0
            ? 'majority'
            : fulfilled.length === 1 ? 'single' : 'unanimous';
          return {
            value: winnerSlot.value,
            source: winnerSlot.url,
            sources: [...sources],
            agreement: earlyAgreement,
            disagreements: losingMembers.map((s) => ({
              url: s.url,
              value: s.value,
              normalizedKey: s.normalizedKey,
            })),
            mode: 'majority',
          };
        }

        // Bail if no key can still reach majority.
        const remaining = pendingIndices.size;
        const bestGroupSize = Math.max(...[...groups.values()].map((g) => g.length));
        if (bestGroupSize + remaining < majorityThreshold) {
          abortAndDrainPending();
          break;
        }

        // Winner-is-decided: leader cannot be dethroned (tie-break by arrival).
        // Guard: >= 2 fulfilled to avoid prematurely freezing 'single'→'unanimous'.
        if (remaining > 0 && fulfilled.length >= 2) {
          const sortedEntries = [...groups.entries()].sort(([, a], [, b]) => {
            if (b.length !== a.length) return b.length - a.length;
            return fulfilled.indexOf(a[0]) - fulfilled.indexOf(b[0]);
          });
          const leaderSize = sortedEntries[0][1].length;
          const bestRivalSize = sortedEntries.length > 1 ? sortedEntries[1][1].length : 0;
          if (leaderSize >= bestRivalSize + remaining) {
            abortAndDrainPending();
            break;
          }
        }
      }
    } else {
      // Rejected slot — re-check reachability / winner-is-decided.
      if (mode === 'majority') {
        const remaining = pendingIndices.size;
        const bestGroupSize = groups.size > 0
          ? Math.max(...[...groups.values()].map((g) => g.length))
          : 0;
        if (bestGroupSize + remaining < majorityThreshold) {
          abortAndDrainPending();
          break;
        }

        if (remaining > 0 && fulfilled.length >= 2 && groups.size > 0) {
          const sortedEntries = [...groups.entries()].sort(([, a], [, b]) => {
            if (b.length !== a.length) return b.length - a.length;
            return fulfilled.indexOf(a[0]) - fulfilled.indexOf(b[0]);
          });
          const leaderSize = sortedEntries[0][1].length;
          const bestRivalSize = sortedEntries.length > 1 ? sortedEntries[1][1].length : 0;
          if (leaderSize >= bestRivalSize + remaining) {
            abortAndDrainPending();
            break;
          }
        }
      }
    }
  }

  // ── Post-loop: compute final answer from accumulated sources ─────────────

  const finalFulfilled = sources.filter(
    (s) => s.status === 'fulfilled' && s.value !== null && s.value !== undefined,
  );

  if (finalFulfilled.length === 0) {
    const reasons = sources
      .map((s) => `${redactUrl(s.url)}: ${s.error ?? 'unknown'}`)
      .join('; ');
    throw new Error('all Solana RPCs failed: ' + reasons);
  }

  if (mode === 'all') {
    const winner = finalFulfilled[0];
    return {
      value: winner.value,
      source: winner.url,
      sources: [...sources],
      agreement: finalFulfilled.length === 1 ? 'single' : 'unanimous',
      disagreements: [],
      mode: 'all',
    };
  }

  // mode === 'majority' (post-loop: no majority reached → plurality)
  const sortedGroups = [...groups.entries()].sort(([, membersA], [, membersB]) => {
    if (membersB.length !== membersA.length) return membersB.length - membersA.length;
    return finalFulfilled.indexOf(membersA[0]) - finalFulfilled.indexOf(membersB[0]);
  });

  const [winningKey, winningMembers] = sortedGroups[0];
  const losingMembers = finalFulfilled.filter((s) => s.normalizedKey !== winningKey);

  const n = finalFulfilled.length;
  let agreement;
  if (sortedGroups.length === 1) {
    agreement = n === 1 ? 'single' : 'unanimous';
  } else {
    const majority = Math.floor(n / 2) + 1;
    agreement = winningMembers.length >= majority ? 'majority' : 'plurality';
  }

  return {
    value: winningMembers[0].value,
    source: winningMembers[0].url,
    sources: [...sources],
    agreement,
    disagreements: losingMembers.map((s) => ({
      url: s.url,
      value: s.value,
      normalizedKey: s.normalizedKey,
    })),
    mode: 'majority',
  };
}

// Exposed for tests (mirrors test access pattern in evm.queryQuorum.test.js).
export { solanaQuorum };

// ─── Balance data helpers ─────────────────────────────────────────────────────

/**
 * Fetch all balance data from a single Solana URL.
 *
 * @param {string} url
 * @param {string} address
 * @param {AbortSignal} [quorumSignal]  - quorum-level abort; combined with the
 *   internal timeout via AbortSignal.any so either source tears down the socket.
 * @returns {Promise<{ balResult: *, splResult: *, spl22Result: * }>}
 */
async function fetchAllBalancesFromUrl(url, address, quorumSignal) {
  // Combine quorum-level abort with the per-fetch timeout so either signal
  // cancels the in-flight undici socket immediately — defeats the keep-alive
  // socket-pool hang that v1.2.0's CHANGELOG cites.
  const timeoutSignal = AbortSignal.timeout(SOLANA_TIMEOUT_MS);
  const signal = quorumSignal
    ? AbortSignal.any([quorumSignal, timeoutSignal])
    : timeoutSignal;
  const [balRes, splRes, spl22Res] = await Promise.all([
    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getBalance',
        params: [address, { commitment: 'confirmed' }],
      }),
      signal,
    }),
    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0', id: 2,
        method: 'getTokenAccountsByOwner',
        params: [
          address,
          { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          { encoding: 'jsonParsed', commitment: 'confirmed' },
        ],
      }),
      signal,
    }),
    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0', id: 3,
        method: 'getTokenAccountsByOwner',
        params: [
          address,
          { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
          { encoding: 'jsonParsed', commitment: 'confirmed' },
        ],
      }),
      signal,
    }),
  ]);

  async function checkRes(res) {
    if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
    return j.result;
  }

  const [balResult, splResult, spl22Result] = await Promise.all([
    checkRes(balRes),
    checkRes(splRes),
    checkRes(spl22Res),
  ]);

  return { balResult, splResult, spl22Result };
}

/**
 * Normalize a balance fetch result for quorum comparison.
 * Compares lamport balance + all token raw amounts (sorted by mint).
 * Slot number is intentionally excluded — it can differ across providers.
 *
 * @param {{ balResult: *, splResult: *, spl22Result: * }} v
 * @returns {string}
 */
function normalizeBalanceResult(v) {
  const lamports = v.balResult?.value ?? 0;
  const allAccounts = [
    ...(v.splResult?.value  ?? []),
    ...(v.spl22Result?.value ?? []),
  ];
  // Skip zero-amount accounts (closed accounts, dust, recently created accounts):
  // honest providers can return different sets of these, and `buildBalanceFromRaw`
  // already filters them out, so the comparison key should match what the user
  // actually sees — not the raw RPC response.
  const tokenKey = allAccounts
    .map(acct => {
      const parsed = acct?.account?.data?.parsed?.info;
      if (!parsed) return null;
      const amount = parsed.tokenAmount?.amount ?? '0';
      if (amount === '0') return null;
      return `${parsed.mint}:${amount}`;
    })
    .filter(Boolean)
    .sort()
    .join(',');
  return `${lamports}|${tokenKey}`;
}

/**
 * Build the balance response shape from a raw fetch result.
 *
 * @param {{ balResult: *, splResult: *, spl22Result: * }} raw
 * @param {string} source
 * @returns {object}
 */
function buildBalanceFromRaw(raw, source) {
  const { balResult, splResult, spl22Result } = raw;
  const nativeLamports = balResult?.value ?? 0;
  const nativeAmount   = formatSol(nativeLamports);
  const slot           = balResult?.context?.slot ?? null;

  const tokens = [];
  for (const acct of [...(splResult?.value ?? []), ...(spl22Result?.value ?? [])]) {
    const parsed = acct?.account?.data?.parsed?.info;
    if (!parsed) continue;

    const mint     = parsed.mint;
    const rawAmt   = parsed.tokenAmount?.amount ?? '0';
    const decimals = parsed.tokenAmount?.decimals ?? 0;

    if (rawAmt === '0') continue;

    const known = KNOWN_MINTS[mint];
    tokens.push({
      symbol:   known?.symbol ?? mint.slice(0, 6) + '...',
      amount:   formatSpl(rawAmt, decimals),
      decimals,
      contract: mint,
    });
  }

  return {
    chain:  name,
    native: { symbol: 'SOL', amount: nativeAmount, decimals: 9 },
    tokens,
    error:  null,
    source,
    slot,
  };
}

// ─── TX data helpers ──────────────────────────────────────────────────────────

/**
 * Fetch a transaction from a single Solana URL.
 *
 * @param {string} url
 * @param {string} signature
 * @param {AbortSignal} [quorumSignal]  - quorum-level abort; combined with the
 *   internal timeout via AbortSignal.any.
 * @returns {Promise<{ txData: * }>}
 */
async function fetchTxFromUrl(url, signature, quorumSignal) {
  const timeoutSignal = AbortSignal.timeout(SOLANA_TIMEOUT_MS);
  const signal = quorumSignal
    ? AbortSignal.any([quorumSignal, timeoutSignal])
    : timeoutSignal;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getTransaction',
      params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  return { txData: json.result };
}

/**
 * Normalize a tx fetch result for quorum comparison.
 * Uses slot + fee + error-status as the identity key.
 * Block time is excluded — it can differ slightly across providers.
 *
 * @param {{ txData: * }} v
 * @returns {string}
 */
function normalizeTxResult(v) {
  if (!v?.txData) return 'null';
  const slot   = v.txData.slot ?? '';
  const fee    = v.txData.meta?.fee ?? '';
  const errKey = v.txData.meta?.err ? 'failed' : 'success';
  return `${slot}:${fee}:${errKey}`;
}

/**
 * Build the tx response shape from a raw fetch result.
 *
 * @param {{ txData: * }} raw
 * @param {string} source
 * @param {string} signature
 * @returns {object}
 */
function buildTxFromRaw(raw, source, signature) {
  const result = raw.txData;
  if (!result) {
    return { tx: null, receipt: null, error: 'Transaction not found', source };
  }

  const meta = result.meta ?? {};
  const msg  = result.transaction?.message ?? {};

  const tx = {
    hash:              signature,
    slot:              result.slot,
    blockTime:         result.blockTime,
    fee:               meta.fee,
    status:            meta.err ? 'failed' : 'success',
    accountKeys:       msg.accountKeys ?? [],
    instructions:      msg.instructions ?? [],
    innerInstructions: meta.innerInstructions ?? [],
    logMessages:       meta.logMessages ?? [],
    preBalances:       meta.preBalances ?? [],
    postBalances:      meta.postBalances ?? [],
  };

  return {
    tx,
    receipt:   null,
    error:     null,
    source,
    slot:      result.slot ?? null,
    blockTime: result.blockTime ?? null,
  };
}

// ─── Public exports ───────────────────────────────────────────────────────────

/**
 * Fetch native SOL balance + all SPL token account balances.
 *
 * @param {{ address: string, rpcQuorum?: 'any'|'majority'|'all' }} opts
 * @returns {Promise<{
 *   chain: string,
 *   native: { symbol: string, amount: string, decimals: number },
 *   tokens: { symbol: string, amount: string, decimals: number, contract: string }[],
 *   error: string | null,
 *   source: string,
 *   slot: number | null,
 *   quorum?: { agreement: string, disagreements: Array<object>, sources: Array<object> },
 * }>}
 */
export async function getBalances({ address, rpcQuorum = 'any' } = {}) {
  try {
    const { value, source, agreement, disagreements, sources } = await solanaQuorum(
      rpcQuorum,
      (url, signal) => fetchAllBalancesFromUrl(url, address, signal),
      normalizeBalanceResult,
    );

    const response = buildBalanceFromRaw(value, source);

    if (rpcQuorum !== 'any') {
      response.quorum = { agreement, disagreements, sources };
    }

    return response;
  } catch (err) {
    return { chain: name, native: null, tokens: [], error: err?.message ?? String(err) };
  }
}

/**
 * Fetch a Solana transaction by signature.
 *
 * Default mode returns a minimal normalised object compatible with the CLI
 * display layer (renames signature → hash, restructures the envelope, bolts
 * on receipt: null for EVM-shape parity).
 *
 * When `raw: true`, returns the original `getTransaction` JSON-RPC result
 * UNMODIFIED under `rawRpc`, plus `source` (and `quorum` when applicable).
 * Skips `buildTxFromRaw` entirely — that exists specifically so the README
 * claim of "raw JSON output, local decoding" is true for Solana, not just
 * EVM. See SCHEMA.TX_RAW in src/output/schemas.js.
 *
 * @param {{ signature: string, rpcQuorum?: 'any'|'majority'|'all', raw?: boolean }} opts
 * @returns {Promise<object>}
 */
export async function getTransaction({ signature, rpcQuorum = 'any', raw = false } = {}) {
  try {
    const { value, source, agreement, disagreements, sources } = await solanaQuorum(
      rpcQuorum,
      (url, signal) => fetchTxFromUrl(url, signature, signal),
      normalizeTxResult,
    );

    if (raw) {
      // value is { txData: <original RPC result> }. Pass txData through verbatim.
      const response = { rawRpc: value.txData ?? null, source, error: null };
      if (rpcQuorum !== 'any') {
        response.quorum = { agreement, disagreements, sources };
      }
      return response;
    }

    const response = buildTxFromRaw(value, source, signature);

    if (rpcQuorum !== 'any') {
      response.quorum = { agreement, disagreements, sources };
    }

    return response;
  } catch (err) {
    if (raw) {
      return { rawRpc: null, error: err?.message ?? String(err) };
    }
    return { tx: null, receipt: null, error: err?.message ?? String(err) };
  }
}
