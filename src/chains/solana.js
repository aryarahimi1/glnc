/**
 * src/chains/solana.js
 *
 * Solana Mainnet chain adapter using the public JSON-RPC endpoint.
 * Uses fetch directly (no Solana SDK needed).
 *
 * Exports:
 *   name          — 'solana'
 *   getBalances(address)
 *   getTransaction(txHash)  — txHash here is a base58 transaction signature
 */

export const name = 'solana';

// Free public Solana RPCs tried in order. PublicNode has higher rate limits;
// mainnet-beta is the canonical fallback (throttles hard for anonymous traffic);
// BlastAPI is a final safety net. Mirrors gas.js's SOLANA_RPC_URLS.
const RPC_URLS = [
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.public.blastapi.io',
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

/**
 * Generic JSON-RPC call. Tries each endpoint in RPC_URLS sequentially and
 * returns on first success; throws the last error only if every endpoint fails.
 */
async function rpcCall(method, params = []) {
  let lastErr;
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        lastErr = new Error(`Solana RPC HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      if (json.error) {
        lastErr = new Error(json.error.message ?? JSON.stringify(json.error));
        continue;
      }
      return json.result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('all Solana RPCs failed');
}

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
  // amount is a string representing u64
  const big = BigInt(amount);
  const divisor = BigInt(10 ** decimals);
  const whole = big / divisor;
  const frac = big % divisor;
  return `${whole}.${frac.toString().padStart(decimals, '0')}`;
}

/**
 * Fetch native SOL balance + all SPL token account balances.
 *
 * @param {string} address  - base58 Solana public key
 * @returns {Promise<{
 *   chain: string,
 *   native: { symbol: string, amount: string, decimals: number },
 *   tokens: { symbol: string, amount: string, decimals: number, contract: string }[],
 *   error: string | null
 * }>}
 */
export async function getBalances(address) {
  try {
    const [balResult, splResult] = await Promise.all([
      rpcCall('getBalance', [address, { commitment: 'confirmed' }]),
      rpcCall('getTokenAccountsByOwner', [
        address,
        { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]),
    ]);

    const nativeLamports = balResult?.value ?? 0;
    const nativeAmount = formatSol(nativeLamports);

    const tokens = [];
    for (const acct of splResult?.value ?? []) {
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
    };
  } catch (err) {
    return { chain: name, native: null, tokens: [], error: err?.message ?? String(err) };
  }
}

/**
 * Fetch a Solana transaction by signature.
 * Returns a minimal normalised object compatible with the CLI display layer.
 *
 * @param {string} signature  - base58 transaction signature
 * @returns {Promise<{ tx: object, receipt: object | null, error: string | null }>}
 */
export async function getTransaction(signature) {
  try {
    const result = await rpcCall('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);

    if (!result) return { tx: null, receipt: null, error: 'Transaction not found' };

    const meta = result.meta ?? {};
    const msg  = result.transaction?.message ?? {};

    // Normalise into a shape the decoder layer can consume
    const tx = {
      hash:        signature,
      slot:        result.slot,
      blockTime:   result.blockTime,
      fee:         meta.fee,          // lamports
      status:      meta.err ? 'failed' : 'success',
      accountKeys: msg.accountKeys ?? [],
      instructions: msg.instructions ?? [],
      innerInstructions: meta.innerInstructions ?? [],
      logMessages: meta.logMessages ?? [],
      preBalances:  meta.preBalances ?? [],
      postBalances: meta.postBalances ?? [],
    };

    return { tx, receipt: null, error: null };
  } catch (err) {
    return { tx: null, receipt: null, error: err?.message ?? String(err) };
  }
}
