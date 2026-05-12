/**
 * src/chains/_bech32.js
 *
 * BIP-173 (bech32) + BIP-350 (bech32m) decoder. No external deps.
 *
 * Used by chain-detection to reject malformed/typo'd bc1... addresses so they
 * don't silently route to the Bitcoin adapter and return a misleading "0 BTC".
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST  = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function decodeBech32(addr) {
  if (typeof addr !== 'string') return null;
  if (addr.length < 8 || addr.length > 90) return null;
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  addr = addr.toLowerCase();
  const sep = addr.lastIndexOf('1');
  if (sep < 1 || sep + 7 > addr.length) return null;
  const hrp = addr.slice(0, sep);
  for (let i = 0; i < hrp.length; i++) {
    const cc = hrp.charCodeAt(i);
    if (cc < 33 || cc > 126) return null;
  }
  const data = [];
  for (let i = sep + 1; i < addr.length; i++) {
    const idx = CHARSET.indexOf(addr[i]);
    if (idx === -1) return null;
    data.push(idx);
  }
  const checksum = polymod(hrpExpand(hrp).concat(data));
  const encoding = checksum === BECH32_CONST ? 'bech32'
                 : checksum === BECH32M_CONST ? 'bech32m'
                 : null;
  if (!encoding) return null;
  return { hrp, data: data.slice(0, -6), encoding };
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (const v of data) {
    if (v < 0 || (v >>> fromBits) !== 0) return null;
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

/**
 * Return true iff `address` is a valid Bitcoin mainnet bech32/bech32m
 * segwit address (BIP-173 for v0, BIP-350 for v1+).
 *
 * @param {string} address
 * @returns {boolean}
 */
export function isBitcoinBech32Valid(address) {
  const decoded = decodeBech32(address);
  if (!decoded) return false;
  if (decoded.hrp !== 'bc') return false;
  if (decoded.data.length < 1) return false;
  const witver = decoded.data[0];
  if (witver > 16) return false;
  if (witver === 0 && decoded.encoding !== 'bech32')  return false;
  if (witver > 0  && decoded.encoding !== 'bech32m')  return false;
  const program = convertBits(decoded.data.slice(1), 5, 8, false);
  if (!program) return false;
  if (program.length < 2 || program.length > 40) return false;
  if (witver === 0 && program.length !== 20 && program.length !== 32) return false;
  return true;
}
