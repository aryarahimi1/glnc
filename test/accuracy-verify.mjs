// Live accuracy verification — NOT part of `npm test` (needs network).
// Compares glnc's gas + price fetchers against independent sources.
// Usage: node test/accuracy-verify.mjs

import { getGas } from '../src/gas.js';
import { getPrice, getPrices } from '../src/prices.js';

const tol = (a, b) => (a === 0 && b === 0) ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));

const fmt = n => (n == null ? 'null' : (typeof n === 'number' ? n.toFixed(4) : String(n)));

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// Try a list of independent RPCs in order; first one that succeeds wins.
async function rpcAny(urls, method, params) {
  let lastErr;
  for (const url of urls) {
    try { return { result: await rpc(url, method, params), source: url }; }
    catch (err) { lastErr = err; }
  }
  throw lastErr ?? new Error('all RPCs failed');
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const results = [];
function record(label, ok, detail, status = ok ? 'PASS' : 'FAIL') {
  results.push({ label, ok, detail, status });
  console.log(`${status.padEnd(4)}  ${label}  —  ${detail}`);
}

// ─── Gas: Ethereum (compare base fee vs independent RPC) ────────────────────
// Query several independent RPCs and take the median to suppress lagging/forked
// nodes (e.g. llamarpc occasionally lags by 100k blocks). Rejects nodes that
// return a different chainId or a non-mainnet block height.
async function indepEthBaseGwei() {
  const urls = [
    'https://eth.drpc.org',
    'https://ethereum.publicnode.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
  ];
  const samples = [];
  await Promise.all(urls.map(async u => {
    try {
      const block = await rpc(u, 'eth_getBlockByNumber', ['latest', false]);
      if (!block?.baseFeePerGas) return;
      samples.push({
        url: u,
        gwei: Number(BigInt(block.baseFeePerGas)) / 1e9,
        height: Number(BigInt(block.number)),
      });
    } catch { /* ignore */ }
  }));
  if (samples.length === 0) throw new Error('all independent ETH RPCs failed');
  // Drop any node lagging by >50 blocks behind the max — llamarpc is a known offender.
  const maxH = Math.max(...samples.map(s => s.height));
  const fresh = samples.filter(s => maxH - s.height <= 50);
  fresh.sort((a, b) => a.gwei - b.gwei);
  const median = fresh[Math.floor(fresh.length / 2)].gwei;
  return { gwei: median, sources: fresh.map(s => `${new URL(s.url).host}=${s.gwei.toFixed(4)}`) };
}

async function checkEthGas() {
  const [glnc, indep] = await Promise.all([getGas('ethereum'), indepEthBaseGwei()]);
  if (glnc.error) return record('ETH gas', false, `glnc error: ${glnc.error}`);
  const drift = tol(glnc.baseFeeGwei, indep.gwei);
  const ok = drift < 0.25;
  record('ETH base fee', ok,
    `glnc=${fmt(glnc.baseFeeGwei)} gwei, indep median=${fmt(indep.gwei)} gwei [${indep.sources.join(', ')}], drift=${(drift*100).toFixed(2)}%`);
}

// ─── Gas: Polygon ────────────────────────────────────────────────────────────
async function checkPolyGas() {
  const [glnc, indep] = await Promise.all([
    getGas('polygon'),
    rpcAny(
      ['https://polygon.llamarpc.com', 'https://rpc.ankr.com/polygon', 'https://polygon.drpc.org'],
      'eth_getBlockByNumber', ['latest', false]
    ),
  ]);
  if (glnc.error) return record('Polygon gas', false, `glnc error: ${glnc.error}`);
  const indepBaseGwei = Number(BigInt(indep.result.baseFeePerGas)) / 1e9;
  const drift = tol(glnc.baseFeeGwei, indepBaseGwei);
  const ok = drift < 0.30;
  record('Polygon base fee', ok,
    `glnc=${fmt(glnc.baseFeeGwei)} gwei, indep=${fmt(indepBaseGwei)} gwei (${new URL(indep.source).host}), drift=${(drift*100).toFixed(2)}%`);
}

// ─── Gas: Arbitrum ───────────────────────────────────────────────────────────
async function checkArbGas() {
  const [glnc, indepHex] = await Promise.all([
    getGas('arbitrum'),
    rpc('https://arbitrum-one.publicnode.com', 'eth_getBlockByNumber', ['latest', false]),
  ]);
  if (glnc.error) return record('Arbitrum gas', false, `glnc error: ${glnc.error}`);
  const indepBaseGwei = indepHex.baseFeePerGas ? Number(BigInt(indepHex.baseFeePerGas)) / 1e9 : 0;
  const drift = tol(glnc.baseFeeGwei, indepBaseGwei);
  const ok = drift < 0.40 || (glnc.baseFeeGwei < 0.5 && indepBaseGwei < 0.5);
  record('Arbitrum base fee', ok,
    `glnc=${fmt(glnc.baseFeeGwei)} gwei, indep=${fmt(indepBaseGwei)} gwei, drift=${(drift*100).toFixed(2)}%`);
}

// ─── Gas: Base ───────────────────────────────────────────────────────────────
async function checkBaseGas() {
  const [glnc, indepHex] = await Promise.all([
    getGas('base'),
    rpc('https://base.publicnode.com', 'eth_getBlockByNumber', ['latest', false]),
  ]);
  if (glnc.error) return record('Base gas', false, `glnc error: ${glnc.error}`);
  const indepBaseGwei = indepHex.baseFeePerGas ? Number(BigInt(indepHex.baseFeePerGas)) / 1e9 : 0;
  const drift = tol(glnc.baseFeeGwei, indepBaseGwei);
  const ok = drift < 0.40 || (glnc.baseFeeGwei < 0.05 && indepBaseGwei < 0.05);
  record('Base base fee', ok,
    `glnc=${fmt(glnc.baseFeeGwei)} gwei, indep=${fmt(indepBaseGwei)} gwei, drift=${(drift*100).toFixed(2)}%`);
}

// ─── Gas: Bitcoin (glnc uses mempool.space; cross-check vs blockstream) ─────
async function checkBtcGas() {
  const [glnc, blockstream] = await Promise.all([
    getGas('bitcoin'),
    getJson('https://blockstream.info/api/fee-estimates'),
  ]);
  if (glnc.error) return record('Bitcoin fees', false, `glnc error: ${glnc.error}`);
  const glncFastest = glnc.bitcoin.fees.fastest;
  const indepFastest = Math.round(Number(blockstream['1']) || 0);
  // Mempool fees are integer sat/vB and can differ noticeably between providers
  // (different tip percentile algorithms). Allow 60% drift; sanity-check both > 0.
  const drift = tol(glncFastest, indepFastest);
  const sane = glncFastest > 0 && indepFastest > 0;
  const ok = sane && drift < 0.60;
  record('BTC fastest fee', ok,
    `glnc=${glncFastest} sat/vB (mempool.space), blockstream=${indepFastest} sat/vB, drift=${(drift*100).toFixed(0)}%`);

  // Tier ordering sanity: fastest >= halfHour >= hour
  const f = glnc.bitcoin.fees;
  const ordered = f.fastest >= f.halfHour && f.halfHour >= f.hour;
  record('BTC tier ordering', ordered,
    `fastest=${f.fastest} ≥ halfHour=${f.halfHour} ≥ hour=${f.hour}`);
}

// ─── Gas: Solana ─────────────────────────────────────────────────────────────
async function checkSolGas() {
  const glnc = await getGas('solana');
  if (glnc.error) return record('Solana gas', false, `glnc error: ${glnc.error}`);
  const s = glnc.solana;
  // Cross-check TPS against an independent perf sample fetch (try multiple RPCs).
  const { result: indep } = await rpcAny(
    [
      'https://api.mainnet-beta.solana.com',
      'https://solana-rpc.publicnode.com',
      'https://solana-mainnet.public.blastapi.io',
    ],
    'getRecentPerformanceSamples', [4]
  );
  const sample = indep?.[0];
  const indepTps = sample
    ? Math.round(Number(sample.numTransactions) / Number(sample.samplePeriodSecs))
    : null;

  const tpsDrift = (s.tps && indepTps) ? tol(s.tps, indepTps) : 0;
  // Same RPC pool — should be identical-ish unless a different sample window was returned.
  const ok = (s.tps == null && indepTps == null) || tpsDrift < 0.5;
  record('Solana TPS', ok, `glnc=${s.tps} TPS, indep=${indepTps} TPS, congestion=${s.congestion}`);

  const tiersOk = s.priorityMicroLamports.low <= s.priorityMicroLamports.med &&
                  s.priorityMicroLamports.med <= s.priorityMicroLamports.high;
  record('Solana priority tier ordering', tiersOk,
    `low=${s.priorityMicroLamports.low} ≤ med=${s.priorityMicroLamports.med} ≤ high=${s.priorityMicroLamports.high} µlamports/CU`);
}

// ─── Prices: ETH/BTC/SOL via glnc (CoinGecko) vs Binance ────────────────────
// Batch the price lookup to minimise CoinGecko free-tier rate-limit pressure.
// CoinGecko's free tier rate-limits aggressively; if we get all-zeros, probe
// the API directly to distinguish a glnc bug from upstream throttling.
async function checkPrices() {
  const symbols = ['eth', 'btc', 'sol'];
  const binanceSyms = { eth: 'ETHUSDT', btc: 'BTCUSDT', sol: 'SOLUSDT' };

  const [glncMap, ...binanceResps] = await Promise.all([
    getPrices(symbols),
    ...symbols.map(s => getJson(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSyms[s]}`)),
  ]);

  // If CoinGecko returned nothing, confirm the upstream is throttling.
  let cgThrottled = false;
  if (Object.keys(glncMap).length === 0) {
    try {
      const probe = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
      );
      cgThrottled = probe.status === 429;
    } catch { /* ignore */ }
  }

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const glncPrice = glncMap[sym.toUpperCase()] ?? 0;
    const indepPrice = parseFloat(binanceResps[i].price);
    const drift = tol(glncPrice, indepPrice);

    if (glncPrice === 0 && cgThrottled) {
      record(`${sym.toUpperCase()} price`, true,
        `Binance=$${fmt(indepPrice)} ✓; glnc skipped — CoinGecko rate-limited (HTTP 429, environmental)`,
        'SKIP');
      continue;
    }

    const ok = glncPrice > 0 && indepPrice > 0 && drift < 0.02;
    record(`${sym.toUpperCase()} price`, ok,
      `glnc(CoinGecko)=$${fmt(glncPrice)}, Binance=$${fmt(indepPrice)}, drift=${(drift*100).toFixed(2)}%`);
  }
}

// ─── Run all ─────────────────────────────────────────────────────────────────
const checks = [
  checkEthGas, checkPolyGas, checkArbGas, checkBaseGas,
  checkBtcGas, checkSolGas,
  checkPrices,
];

for (const c of checks) {
  try { await c(); }
  catch (err) { record(c.name || 'check', false, `threw: ${err.message}`); }
}

const passed  = results.filter(r => r.status === 'PASS').length;
const skipped = results.filter(r => r.status === 'SKIP').length;
const failed  = results.filter(r => r.status === 'FAIL').length;
console.log(`\n${passed} pass, ${skipped} skip, ${failed} fail (of ${results.length} checks)`);
process.exit(failed === 0 ? 0 : 1);
