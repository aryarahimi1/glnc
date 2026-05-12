/**
 * src/cli/args.js
 *
 * Minimal argument parser — no external dependencies.
 *
 * Parses process.argv into a structured command object:
 *   {
 *     command: 'balance' | 'tx' | 'help' | 'version',
 *     address: string | null,       // addresses[0] ?? null — backward-compat
 *     addresses: string[],          // all addresses for multi-wallet balance
 *     txHash: string | null,
 *     chain: string | null,         // value of --chain flag, lowercased
 *     json: boolean,                // true if --json was passed
 *     verbose: boolean,
 *     watch: boolean,               // true if --watch / -w was passed
 *     interval: number,             // seconds between watch refreshes (default 15)
 *     positions: boolean,           // true if --positions / -p was passed
 *     raw: string[],                // original argv slice after 'bun run glnc.js'
 *   }
 *
 * Throws a ParseError (exitCode 1) for bad usage.
 */

export class ParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ParseError';
    this.exitCode = 1;
  }
}

/**
 * Parse a --interval value as a strictly positive integer. Rejects 0 and
 * non-numeric input outright instead of silently falling back to the default.
 *
 * @param {string} value
 * @returns {number}
 */
function parseInterval(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ParseError(`--interval must be a positive integer (got: ${JSON.stringify(value)})`);
  }
  return n;
}

/**
 * @typedef {{
 *   command: string,
 *   address: string|null,
 *   addresses: string[],
 *   txHash: string|null,
 *   chain: string|null,
 *   json: boolean,
 *   ndjson: boolean,
 *   strict: boolean,
 *   schemaInfo: boolean,
 *   verbose: boolean,
 *   watch: boolean,
 *   interval: number,
 *   positions: boolean,
 *   condition: string|null,
 *   webhook: string|null,
 *   once: boolean,
 *   dryRun: boolean,
 *   rpc: string|null,
 *   raw: string[]
 * }} ParsedArgs
 */

/**
 * Parse the given argv slice (everything after the runtime + script path).
 * Pass `process.argv.slice(2)` in normal usage.
 *
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  const raw = [...argv];

  // Flags
  let chain = null;
  let json = false;
  let ndjson = false;
  let strict = false;
  let schemaInfo = false;
  let verbose = false;
  let watch = false;
  let intervalRaw = null; // null = not explicitly set; resolved per-command below
  let positions = false;
  let nfts = false;
  let condition = null;
  let webhook = null;
  let once = false;
  let dryRun = false;
  let rpc = null;
  let fromDate = null;
  let toDate = null;
  let outPath = null;
  let apiKey = null;
  let noPrices = false;
  let showUnpriced = false;
  let helpRequested = false;

  // Extract flags anywhere in argv; non-flag tokens go into filtered
  const filtered = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--chain=')) {
      chain = arg.slice('--chain='.length).toLowerCase();
    } else if (arg === '--chain') {
      if (i + 1 >= argv.length) {
        throw new ParseError('--chain requires a value (e.g. --chain eth)');
      }
      chain = argv[++i].toLowerCase();
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--ndjson') {
      json = true;
      ndjson = true;
    } else if (arg === '--no-color' || arg === '--no-colour') {
      // Honored by src/cli/theme.js at module load via process.argv;
      // swallow here so it doesn't fall through to filtered[].
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--schema') {
      schemaInfo = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--watch' || arg === '-w') {
      watch = true;
    } else if (arg.startsWith('--interval=')) {
      intervalRaw = parseInterval(arg.slice('--interval='.length));
    } else if (arg === '--interval') {
      if (i + 1 >= argv.length) {
        throw new ParseError('--interval requires a positive integer (seconds)');
      }
      intervalRaw = parseInterval(argv[++i]);
    } else if (arg === '--positions' || arg === '-p') {
      positions = true;
    } else if (arg === '--nfts' || arg === '-n') {
      nfts = true;
    } else if (arg.startsWith('--on=')) {
      condition = arg.slice('--on='.length);
    } else if (arg === '--on') {
      if (i + 1 >= argv.length) {
        throw new ParseError('--on requires a condition string (e.g. --on "balance.eth < 300")');
      }
      condition = argv[++i];
    } else if (arg.startsWith('--webhook=')) {
      webhook = arg.slice('--webhook='.length);
    } else if (arg === '--webhook') {
      if (i + 1 >= argv.length) {
        throw new ParseError('--webhook requires a URL (e.g. --webhook https://...)');
      }
      webhook = argv[++i];
    } else if (arg === '--once') {
      once = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--rpc=')) {
      rpc = arg.slice('--rpc='.length);
    } else if (arg === '--rpc') {
      if (i + 1 >= argv.length) {
        throw new ParseError('--rpc requires a URL');
      }
      rpc = argv[++i];
    } else if (arg.startsWith('--from=')) {
      fromDate = arg.slice('--from='.length);
    } else if (arg === '--from') {
      if (i + 1 >= argv.length) {
        throw new ParseError('--from requires a date (YYYY-MM-DD)');
      }
      fromDate = argv[++i];
    } else if (arg.startsWith('--to=')) {
      toDate = arg.slice('--to='.length);
    } else if (arg === '--to') {
      if (i + 1 >= argv.length) {
        throw new ParseError('--to requires a date (YYYY-MM-DD)');
      }
      toDate = argv[++i];
    } else if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length);
    } else if (arg === '--out' || arg === '-o') {
      if (i + 1 >= argv.length) {
        throw new ParseError('--out requires a file path');
      }
      outPath = argv[++i];
    } else if (arg.startsWith('--api-key=')) {
      apiKey = arg.slice('--api-key='.length);
    } else if (arg === '--api-key') {
      if (i + 1 >= argv.length) {
        throw new ParseError('--api-key requires a value');
      }
      apiKey = argv[++i];
    } else if (arg === '--no-prices') {
      noPrices = true;
    } else if (arg === '--show-unpriced') {
      showUnpriced = true;
    } else if (arg === '--help' || arg === '-h') {
      helpRequested = true;
    } else {
      filtered.push(arg);
    }
  }

  // Normalize chain aliases
  if (chain !== null) {
    chain = normalizeChain(chain);
  }

  // filtered[0] is the sub-command (or a flag)
  const first = filtered[0];

  // Resolve interval default based on command (alert uses 120, others use 15)
  const isAlertCmd = first === 'alert';
  const interval = intervalRaw ?? (isAlertCmd ? 120 : 15);

  // Shared flags carried by every parsed result, regardless of subcommand.
  const flagBase = {
    chain, json, ndjson, strict, schemaInfo,
    verbose, watch, interval, positions, nfts,
    condition, webhook, once, dryRun, rpc,
    fromDate, toDate, outPath, apiKey, noPrices, showUnpriced,
    raw,
  };

  // `--help` / `-h` anywhere → command-specific help when first is a known
  // command, global help otherwise.
  if (helpRequested) {
    return {
      command: 'help',
      address: null,
      addresses: [],
      txHash: null,
      helpFor: first ?? null,
      ...flagBase,
    };
  }

  if (first === undefined || first === 'help') {
    return { command: 'help', address: null, addresses: [], txHash: null, helpFor: null, ...flagBase };
  }

  if (first === '--version' || first === '-V' || first === 'version') {
    return { command: 'version', address: null, addresses: [], txHash: null, ...flagBase };
  }

  if (first === 'interactive' || first === 'i' || first === '--interactive' || first === '-i') {
    return { command: 'interactive', address: null, addresses: [], txHash: null, ...flagBase };
  }

  if (first === 'balance') {
    // Collect ALL positional args after the 'balance' subcommand token
    const addresses = filtered.slice(1);
    if (addresses.length === 0) {
      throw new ParseError('Usage: glnc balance <address> [address2 ...] [--chain <name>]');
    }
    if (chain !== null && !BALANCE_SUPPORTED_CHAINS.includes(chain)) {
      throw new ParseError(
        `balance not supported on chain "${chain}". ` +
        `Supported: ${BALANCE_SUPPORTED_CHAINS.join(', ')}. ` +
        `(${chain} works for "glnc gas --chain ${chain}".)`
      );
    }
    return {
      command: 'balance',
      address: addresses[0],
      addresses,
      txHash: null,
      ...flagBase,
    };
  }

  if (first === 'tx') {
    const txHash = filtered[1] ?? null;
    if (!txHash) {
      throw new ParseError('Usage: glnc tx <hash> [--chain <name>]');
    }
    if (chain !== null && !BALANCE_SUPPORTED_CHAINS.includes(chain)) {
      throw new ParseError(
        `tx decoding not supported on chain "${chain}". ` +
        `Supported: ${BALANCE_SUPPORTED_CHAINS.join(', ')}.`
      );
    }
    return { command: 'tx', address: null, addresses: [], txHash, ...flagBase };
  }

  if (first === 'gas' || first === 'g') {
    // gas takes no positional args; only flags.
    return { command: 'gas', address: null, addresses: [], txHash: null, ...flagBase };
  }

  if (first === 'history' || first === 'hist' || first === 'h') {
    const histAddress = filtered[1] ?? null;
    if (!histAddress) {
      throw new ParseError(
        'Usage: glnc history <address> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--chain eth] [--out file.csv]'
      );
    }
    return {
      command: 'history',
      address: histAddress,
      addresses: [histAddress],
      txHash: null,
      ...flagBase,
    };
  }

  if (first === 'schema' || first === 'schemas') {
    // glnc schema → list all schema ids; glnc schema <name> → print one
    return { command: 'schema', address: null, addresses: filtered.slice(1), txHash: null, ...flagBase };
  }

  if (first === 'alert') {
    const alertAddress = filtered[1] ?? null;
    if (!alertAddress) {
      throw new ParseError('Usage: glnc alert <address> --on "<condition>" --webhook <url> [--chain <name>] [--once] [--dry-run] [--interval <seconds>]');
    }
    if (!condition) {
      throw new ParseError('glnc alert requires --on "<condition>" (e.g. --on "balance.eth < 300")');
    }
    if (!webhook) {
      throw new ParseError('glnc alert requires --webhook <url> (e.g. --webhook https://hooks.example.com/...)');
    }
    if (chain !== null && !BALANCE_SUPPORTED_CHAINS.includes(chain)) {
      throw new ParseError(
        `alert not supported on chain "${chain}". ` +
        `Supported: ${BALANCE_SUPPORTED_CHAINS.join(', ')}. ` +
        `(${chain} works for "glnc gas --chain ${chain}".)`
      );
    }

    // Alert minimum interval is 30s
    let alertInterval = interval;
    if (alertInterval < 30) {
      process.stderr.write('Warning: --interval below 30s; clamping to 30.\n');
      alertInterval = 30;
    }

    return {
      command: 'alert',
      address: alertAddress,
      addresses: [alertAddress],
      txHash: null,
      ...flagBase,
      interval: alertInterval,
    };
  }

  throw new ParseError(`Unknown command: "${first}". Run "glnc --help" for usage.`);
}

/**
 * Map common short aliases to canonical chain names used by the adapters.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeChain(raw) {
  const aliases = {
    eth: 'ethereum',
    ethereum: 'ethereum',
    poly: 'polygon',
    polygon: 'polygon',
    matic: 'polygon',
    sol: 'solana',
    solana: 'solana',
    btc: 'bitcoin',
    bitcoin: 'bitcoin',
    arb: 'arbitrum',
    arbitrum: 'arbitrum',
    base: 'base',
    op: 'optimism',
    optimism: 'optimism',
    zk: 'zksync',
    zksync: 'zksync',
    era: 'zksync',
    linea: 'linea',
  };
  return aliases[raw] ?? raw;
}

/**
 * Chains that fully support balance + transaction queries. All EVM chains
 * with adapters exporting getBalances/getTransaction are included here.
 * The alert whitelist auto-picks them up via this list.
 */
export const BALANCE_SUPPORTED_CHAINS = [
  'ethereum', 'polygon', 'arbitrum', 'base', 'optimism', 'linea', 'zksync', 'solana', 'bitcoin',
];
