/**
 * src/chains/bitcoin.js
 *
 * Bitcoin chain adapter using the Blockstream.info public REST API.
 * No API key required.
 *
 * Exports:
 *   name          — 'bitcoin'
 *   getBalances({ address })
 *   getTransaction(txHash)
 */

export const name = 'bitcoin';

const API_BASE = 'https://blockstream.info/api';
const SATOSHIS_PER_BTC = 100_000_000n;

/**
 * Format satoshis as a decimal BTC string.
 */
export function formatBtc(satoshis) {
  const big = BigInt(satoshis);
  const whole = big / SATOSHIS_PER_BTC;
  const frac = big % SATOSHIS_PER_BTC;
  return `${whole}.${frac.toString().padStart(8, '0')}`;
}

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Blockstream API HTTP ${res.status} for ${path}`);
  const text = await res.text();
  const quoted = text.replace(/("(?:funded_txo_sum|spent_txo_sum|value|fee)"\s*:\s*)(\d+)/g, '$1"$2"');
  return JSON.parse(quoted);
}

/**
 * Fetch Bitcoin balance for an address.
 * Blockstream returns { chain_stats, mempool_stats } — we use confirmed balance.
 *
 * @param {{ address: string }} opts  - Bitcoin address (bc1..., 1..., 3...)
 * @returns {Promise<{
 *   chain: string,
 *   native: { symbol: string, amount: string, decimals: number },
 *   tokens: [],
 *   error: string | null
 * }>}
 */
export async function getBalances({ address } = {}) {
  try {
    const data = await apiFetch(`/address/${address}`);

    const confirmedSats =
      BigInt(data.chain_stats?.funded_txo_sum ?? 0) -
      BigInt(data.chain_stats?.spent_txo_sum  ?? 0);

    const mempoolSats =
      BigInt(data.mempool_stats?.funded_txo_sum ?? 0) -
      BigInt(data.mempool_stats?.spent_txo_sum  ?? 0);

    // Total including unconfirmed
    const totalSats = confirmedSats + mempoolSats;
    const amount = formatBtc(totalSats < 0n ? 0n : totalSats);

    return {
      chain:  name,
      native: { symbol: 'BTC', amount, decimals: 8 },
      tokens: [],
      error:  null,
    };
  } catch (err) {
    return { chain: name, native: null, tokens: [], error: err?.message ?? String(err) };
  }
}

/**
 * Fetch a Bitcoin transaction by txid.
 *
 * @param {string} txHash  - 64-char hex txid
 * @returns {Promise<{ tx: object, receipt: null, error: string | null }>}
 */
export async function getTransaction(txHash) {
  try {
    const data = await apiFetch(`/tx/${txHash}`);

    // Normalise into a display-friendly shape
    const totalInput  = (data.vin  ?? []).reduce((s, i) => s + BigInt(i.prevout?.value ?? 0), 0n);
    const totalOutput = (data.vout ?? []).reduce((s, o) => s + BigInt(o.value ?? 0), 0n);
    const fee = totalInput - totalOutput;

    const tx = {
      hash:        data.txid,
      version:     data.version,
      size:        data.size,
      weight:      data.weight,
      fee,                                    // satoshis (BigInt)
      feeBtc:      formatBtc(fee < 0n ? 0n : fee),
      status:      data.status?.confirmed ? 'confirmed' : 'unconfirmed',
      blockHeight: data.status?.block_height ?? null,
      blockTime:   data.status?.block_time   ?? null,
      inputs:  (data.vin  ?? []).map(i => ({
        txid:    i.txid,
        vout:    i.vout,
        value:   BigInt(i.prevout?.value ?? 0),
        address: i.prevout?.scriptpubkey_address ?? null,
      })),
      outputs: (data.vout ?? []).map(o => ({
        value:   BigInt(o.value ?? 0),
        address: o.scriptpubkey_address ?? null,
      })),
    };

    return { tx, receipt: null, error: null };
  } catch (err) {
    return { tx: null, receipt: null, error: err?.message ?? String(err) };
  }
}
