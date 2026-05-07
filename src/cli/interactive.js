/**
 * src/cli/interactive.js
 *
 * Interactive REPL for the `glnc` CLI.
 * Uses the in-house prompts library (zero dependencies).
 *
 * Exports:
 *   runInteractive(version) => Promise<void>
 */

import { runBalance, runTx, runGas, runWatch, runGasWatch, runAlert, runHistory } from '../index.js';
import { renderError } from './render.js';
import { c, theme } from './theme.js';
import { box, select, input, CancelledError } from './prompts.js';

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const vl = s => s.replace(ANSI_RE, '').length;

const BALANCE_CHAINS = [
  { value: null,       icon: '◈', label: 'Auto-detect',  description: 'Pick chains from the address format' },
  { value: 'ethereum', icon: '⬢', label: 'Ethereum',     description: 'EVM mainnet' },
  { value: 'polygon',  icon: '⬡', label: 'Polygon',      description: 'EVM' },
  { value: 'arbitrum', icon: '◆', label: 'Arbitrum',     description: 'EVM L2' },
  { value: 'base',     icon: '▲', label: 'Base',         description: 'EVM L2' },
  { value: 'solana',   icon: '◎', label: 'Solana',       description: 'Non-EVM' },
  { value: 'bitcoin',  icon: '₿', label: 'Bitcoin',      description: 'Non-EVM' },
];

const TX_CHAINS = [
  { value: 'ethereum', icon: '⬢', label: 'Ethereum',  description: 'EVM mainnet (default)' },
  { value: 'polygon',  icon: '⬡', label: 'Polygon',   description: 'EVM' },
  { value: 'arbitrum', icon: '◆', label: 'Arbitrum',  description: 'EVM L2' },
  { value: 'base',     icon: '▲', label: 'Base',      description: 'EVM L2' },
  { value: 'solana',   icon: '◎', label: 'Solana',    description: 'Non-EVM' },
];

const HISTORY_CHAINS = [
  { value: 'ethereum', icon: '⬢', label: 'Ethereum',  description: 'EVM mainnet' },
  { value: 'polygon',  icon: '⬡', label: 'Polygon',   description: 'EVM' },
  { value: 'arbitrum', icon: '◆', label: 'Arbitrum',  description: 'EVM L2' },
  { value: 'base',     icon: '▲', label: 'Base',      description: 'EVM L2' },
  { value: 'optimism', icon: '◉', label: 'Optimism',  description: 'EVM L2 (OP Stack)' },
];

const HISTORY_RANGES = [
  { value: '30',  icon: '·', label: 'Last 30 days',     description: 'Quick recent activity' },
  { value: '90',  icon: '·', label: 'Last 90 days',     description: 'Quarterly snapshot' },
  { value: '365', icon: '·', label: 'Last 12 months',   description: 'Default — fits a tax year' },
  { value: 'ytd', icon: '·', label: 'Year-to-date',     description: 'From Jan 1 of this UTC year' },
  { value: 'all', icon: '·', label: 'Custom dates',     description: 'Enter --from and --to manually' },
];

const ALERT_CHAINS = [
  { value: 'ethereum', icon: '⬢', label: 'Ethereum',  description: 'EVM mainnet' },
  { value: 'polygon',  icon: '⬡', label: 'Polygon',   description: 'EVM' },
  { value: 'arbitrum', icon: '◆', label: 'Arbitrum',  description: 'EVM L2' },
  { value: 'base',     icon: '▲', label: 'Base',      description: 'EVM L2' },
  { value: 'solana',   icon: '◎', label: 'Solana',    description: 'Non-EVM' },
  { value: 'bitcoin',  icon: '₿', label: 'Bitcoin',   description: 'Non-EVM' },
];

const YES_NO = [
  { value: false, label: 'No',  icon: '·' },
  { value: true,  label: 'Yes', icon: '✓' },
];

const OUTPUT_MODES = [
  { value: 'pretty', icon: '◐', label: 'Pretty',  description: 'Human terminal UI (default)' },
  { value: 'json',   icon: '◍', label: 'JSON',    description: 'Single-document envelope per command' },
  { value: 'ndjson', icon: '◎', label: 'NDJSON',  description: 'One envelope per line; live tail in --watch' },
];

const GAS_CHAIN_CHOICES = [
  { value: null,       icon: '◈', label: 'All chains',  description: 'EVM + Bitcoin + Solana' },
  { value: 'ethereum', icon: '⬢', label: 'Ethereum',    description: 'EVM mainnet' },
  { value: 'polygon',  icon: '⬡', label: 'Polygon',     description: 'EVM' },
  { value: 'arbitrum', icon: '◆', label: 'Arbitrum',    description: 'EVM L2' },
  { value: 'base',     icon: '▲', label: 'Base',        description: 'EVM L2' },
  { value: 'optimism', icon: '◉', label: 'Optimism',    description: 'EVM L2 (OP Stack)' },
  { value: 'zksync',   icon: '⟁', label: 'zkSync Era',  description: 'EVM L2 (ZK rollup)' },
  { value: 'linea',    icon: '⬣', label: 'Linea',       description: 'EVM L2 (Consensys)' },
  { value: 'bitcoin',  icon: '₿', label: 'Bitcoin',     description: 'mempool fees (sat/vB)' },
  { value: 'solana',   icon: '◎', label: 'Solana',      description: 'Priority fees (μL/CU)' },
];

function printBanner(version) {
  const cols = process.stdout.columns || 90;
  const LEFT_W = 26;
  const PX = 2;
  // total box width = 2(borders) + 2*PX + LEFT_W + 1(divider) + RIGHT_W = 33 + RIGHT_W
  const RIGHT_W = Math.max(36, Math.min(cols - 33, 55));

  // center s within a field of W visible chars
  const ctr = (s, W = LEFT_W) => {
    const pad = Math.max(0, W - vl(s));
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + s + ' '.repeat(pad - l);
  };

  // trailing space gives breathing room between divider and right panel text
  const div = theme.brand('│') + ' ';
  const pr = (s, W = RIGHT_W - 1) => s + ' '.repeat(Math.max(0, W - vl(s)));

  // Two-column chain row, first col padded to width 14
  const chRow = (g1, n1, g2, n2) => {
    const col1 = theme.brand(g1) + c.dim(' ' + n1) +
      ' '.repeat(Math.max(1, 14 - (1 + 1 + n1.length)));
    return col1 + theme.brand(g2) + c.dim(' ' + n2);
  };

  const rows = [
    [ctr(c.bold(theme.brand('◈  glnc'))),
     pr(c.bold('Quick start'))],
    [ctr(c.dim('blockchain inspector')),
     pr(theme.brand('⬢') + c.bold('  glnc balance') + c.dim(' <address>'))],
    [ctr(''),
     pr(theme.brand('⟳') + c.bold('  glnc tx') + c.dim(' <hash>'))],
    [ctr(theme.brand('⬢  ⬡  ◆  ▲  ◎  ₿')),
     pr(theme.brand('⛽') + c.bold('  glnc gas') + c.dim(' [--chain eth]'))],
    [ctr(''),
     pr(c.dim('─'.repeat(RIGHT_W - 1)))],
    [ctr(theme.brand('◈') + c.dim('  balance · tx · gas')),
     pr(c.bold('Chains'))],
    [ctr(''),
     pr(chRow('⬢', 'Ethereum', '◆', 'Arbitrum'))],
    [ctr(theme.gold('Esc') + c.dim(' back · ') + theme.gold('Ctrl+C') + c.dim(' quit')),
     pr(chRow('⬡', 'Polygon', '▲', 'Base'))],
    [ctr(''),
     pr(chRow('◎', 'Solana', '₿', 'Bitcoin'))],
  ].map(([l, r]) => l + div + r);

  console.log('');
  console.log(box(rows, { title: 'glnc v' + version, paddingX: PX }));
  console.log('');
}

function printSeparator() {
  const w = Math.min((process.stdout.columns || 80) - 4, 60);
  const label = ' ◈ ';
  const sideLen = Math.max(0, Math.floor((w - label.length) / 2));
  const dashes = '╌'.repeat(sideLen);
  console.log('');
  console.log('  ' + theme.brandDim(dashes + label + dashes));
}

/**
 * Map a session output mode ('pretty' | 'json' | 'ndjson') to the option
 * flags expected by the run* functions.
 */
function outputOpts(mode) {
  return mode === 'pretty' ? {} : { json: true };
}

async function balanceFlow(session) {
  const address = await input({
    message: 'Address',
    placeholder: session.lastAddress || '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    acceptPlaceholder: true,
    required: true,
  });
  session.lastAddress = address.trim();

  const chain = await select({
    message: 'Which chain?',
    choices: BALANCE_CHAINS,
  });

  const positions = await select({
    message: 'Include DeFi positions (Aave, Uniswap V3)?',
    choices: YES_NO,
  });

  const nfts = await select({
    message: 'Include NFT holdings (counts + floor prices)?',
    hint: 'Reservoir API · text only, no images',
    choices: YES_NO,
  });

  const watch = await select({
    message: 'Watch mode (live refresh)?',
    choices: YES_NO,
  });

  let interval = 15;
  if (watch) {
    const raw = await input({
      message: 'Refresh interval (seconds)',
      placeholder: '15',
      initial: '15',
    });
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) interval = n;
  }

  console.log('');
  const out = outputOpts(session.outputMode);
  if (watch) {
    await runWatch(address.trim(), chain, { positions, nfts, interval, ...out });
  } else {
    await runBalance(address.trim(), chain, { positions, nfts, ...out });
  }
}

async function gasFlow(session) {
  const chain = await select({
    message: 'Which chain?',
    choices: GAS_CHAIN_CHOICES,
  });

  const watch = await select({
    message: 'Watch mode (live refresh)?',
    choices: YES_NO,
  });

  let interval = 15;
  if (watch) {
    const raw = await input({
      message: 'Refresh interval (seconds)',
      placeholder: '15',
      initial: '15',
    });
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) interval = n;
  }

  console.log('');
  const out = outputOpts(session.outputMode);
  if (watch) {
    await runGasWatch(chain, { interval, ...out });
  } else {
    await runGas(chain, out);
  }
}

async function txFlow(session) {
  const hash = await input({
    message: 'Transaction hash',
    placeholder: '0x… (64 hex) or base58 (Solana)',
    required: true,
  });

  const chain = await select({
    message: 'Which chain?',
    choices: TX_CHAINS,
  });

  console.log('');
  await runTx(hash.trim(), chain, outputOpts(session.outputMode));
}

async function historyFlow(session) {
  const address = await input({
    message: 'Address (EVM only for v1)',
    placeholder: session.lastAddress || '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    acceptPlaceholder: true,
    required: true,
  });
  session.lastAddress = address.trim();

  const chain = await select({
    message: 'Which chain?',
    hint: 'history is EVM-only in v1',
    choices: HISTORY_CHAINS,
  });

  const rangeChoice = await select({
    message: 'Date range?',
    choices: HISTORY_RANGES,
    initial: 2, // 365 days — labeled "Default — fits a tax year"
  });

  let from = null;
  let to = null;
  const today = new Date();
  const ymd = d => d.toISOString().slice(0, 10);

  if (rangeChoice === 'ytd') {
    from = `${today.getUTCFullYear()}-01-01`;
    to = ymd(today);
  } else if (rangeChoice === 'all') {
    const fromIn = await input({
      message: 'From date (YYYY-MM-DD)',
      placeholder: '2025-01-01',
    });
    const toIn = await input({
      message: 'To date (YYYY-MM-DD)',
      placeholder: ymd(today),
      initial: ymd(today),
    });
    from = fromIn.trim() || null;
    to = toIn.trim() || null;
  } else {
    const days = parseInt(rangeChoice, 10);
    const fromDate = new Date(today.getTime() - days * 86400_000);
    from = ymd(fromDate);
    to = ymd(today);
  }

  const destination = await select({
    message: 'Where should the CSV go?',
    choices: [
      { value: 'auto',   icon: '✓', label: 'File (auto-named)', description: 'glnc-history-<chain>-<addr>-<date>.csv in cwd' },
      { value: 'custom', icon: '·', label: 'File (custom path)', description: 'Type a filename below' },
      { value: 'stdout', icon: '·', label: 'Print to stdout',    description: 'Pipe-friendly (no file written)' },
    ],
  });

  let outPath = null;
  if (destination === 'auto') outPath = 'auto';
  else if (destination === 'custom') {
    const p = await input({
      message: 'CSV file path',
      placeholder: 'history.csv',
    });
    outPath = p.trim() || null;
    if (!outPath) {
      console.log(c.dim('  no path provided — defaulting to stdout'));
    }
  }

  const includePrices = await select({
    message: 'Fetch historical USD prices?',
    hint: 'CoinGecko free API · slower but lights up the usd_value column',
    choices: [
      { value: true,  icon: '✓', label: 'Yes — include USD values', description: 'Recommended for tax export' },
      { value: false, icon: '·', label: 'No — skip price lookup',   description: 'Much faster, usd_value will be empty' },
    ],
  });

  const apiKey = process.env.GLNC_ETHERSCAN_KEY ?? null;
  let useKey = apiKey;
  if (!apiKey) {
    const askKey = await select({
      message: 'Etherscan V2 API key?',
      hint: 'Optional, but lifts the public rate limit (5 req/s)',
      choices: [
        { value: false, icon: '·', label: 'Skip (use anonymous rate limit)', description: 'Fine for short ranges' },
        { value: true,  icon: '·', label: 'Enter a key',                      description: 'Free at etherscan.io/myapikey' },
      ],
    });
    if (askKey) {
      const k = await input({ message: 'API key', placeholder: 'ABCDEF...' });
      useKey = k.trim() || null;
    }
  }

  console.log('');
  const out = outputOpts(session.outputMode);
  await runHistory(address.trim(), {
    chain,
    from,
    to,
    out: outPath,
    apiKey: useKey,
    noPrices: !includePrices,
    ...out,
  });
}

async function alertFlow(session) {
  const address = await input({
    message: 'Address to monitor',
    placeholder: session.lastAddress || '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    acceptPlaceholder: true,
    required: true,
  });
  session.lastAddress = address.trim();

  const chain = await select({
    message: 'Which chain?',
    hint: 'alert requires a single chain',
    choices: ALERT_CHAINS,
  });

  const condition = await input({
    message: 'Condition',
    placeholder: 'balance.eth < 300',
    acceptPlaceholder: true,
    required: true,
  });

  const webhook = await input({
    message: 'Webhook URL',
    placeholder: 'https://httpbin.org/post',
    acceptPlaceholder: true,
    required: true,
  });

  const dryRun = await select({
    message: 'Dry-run (evaluate without firing webhook)?',
    hint: 'recommended for the first run',
    choices: YES_NO,
    initial: 1, // default Yes — safer first run
  });

  const once = await select({
    message: 'Run once and exit, or loop forever?',
    choices: [
      { value: false, label: 'Loop',  icon: '↻', description: 'Poll on interval until Ctrl+C (default)' },
      { value: true,  label: 'Once',  icon: '·', description: 'Evaluate one time then return to menu' },
    ],
  });

  let interval = 120;
  if (!once) {
    const raw = await input({
      message: 'Polling interval (seconds, min 30)',
      placeholder: '120',
      initial: '120',
    });
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 30) interval = n;
  }

  console.log('');
  await runAlert(address.trim(), {
    condition: condition.trim(),
    webhook: webhook.trim(),
    chain,
    interval,
    once,
    dryRun,
    verbose: false,
    ...outputOpts(session.outputMode),
  });
}

async function outputModeFlow(session) {
  const next = await select({
    message: `Output mode (current: ${session.outputMode})`,
    hint: 'pipe-friendly modes route data to stdout, chatter to stderr',
    choices: OUTPUT_MODES,
  });
  session.outputMode = next;
  console.log(c.dim(`  output mode → ${next}`));
}

/**
 * Run the interactive REPL loop until the user quits.
 *
 * @param {string} version
 * @returns {Promise<void>}
 */
export async function runInteractive(version) {
  if (!process.stdin.isTTY) {
    renderError('Interactive mode requires a TTY (stdin must be a terminal).');
    process.exitCode = 1;
    return;
  }

  printBanner(version);

  // Per-session preferences. Survives across menu iterations until quit.
  const session = { outputMode: 'pretty', lastAddress: null };

  while (true) {
    let action;
    try {
      action = await select({
        message: `What would you like to do?  ${c.dim('[output: ' + session.outputMode + ']')}`,
        hint: '↑/↓ move · Enter select · q quit · Ctrl+C exit',
        choices: [
          { value: 'balance', label: 'Check balance',      icon: '◈', description: 'Native + token balances, optional watch & DeFi positions' },
          { value: 'tx',      label: 'Decode transaction', icon: '⟳', description: 'Inspect a transaction by hash' },
          { value: 'gas',     label: 'Gas prices',         icon: '⛽', description: 'Current or live-watch gas across chains' },
          { value: 'history', label: 'Tax history (CSV)',  icon: '📑', description: 'Pull tx history for a date range and export as CSV' },
          { value: 'alert',   label: 'Set up alert',       icon: '🔔', description: 'Monitor a wallet and POST to a webhook on condition' },
          { value: 'output',  label: 'Output mode',        icon: '◈', description: 'Switch between pretty / JSON / NDJSON for the session' },
          { value: 'quit',    label: 'Quit',               icon: '←', description: 'Exit interactive mode' },
        ],
      });
    } catch (err) {
      if (err instanceof CancelledError) {
        console.log('\n' + c.dim('  Goodbye.'));
        return;
      }
      throw err;
    }

    if (action === 'quit') {
      console.log('\n' + c.dim('  Goodbye.'));
      return;
    }

    try {
      if (action === 'balance') await balanceFlow(session);
      else if (action === 'tx') await txFlow(session);
      else if (action === 'gas') await gasFlow(session);
      else if (action === 'history') await historyFlow(session);
      else if (action === 'alert') await alertFlow(session);
      else if (action === 'output') await outputModeFlow(session);
    } catch (err) {
      if (err instanceof CancelledError) {
        console.log(c.dim('  cancelled — back to menu'));
      } else {
        renderError(err?.message ?? String(err));
      }
    }

    // Reset any non-zero exit code set by sub-commands so a clean quit returns 0.
    process.exitCode = 0;
    printSeparator();
  }
}
