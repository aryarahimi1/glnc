/**
 * Gnosis Safe MultiSend packed transaction decoder.
 * Format per operation: operation(1) | to(20) | value(32) | dataLen(32) | data(N)
 */

const MAX_BYTES = 65_536;

function toBytes(packedHex) {
  if (packedHex instanceof Uint8Array) return packedHex;
  const raw = typeof packedHex === 'string'
    ? (packedHex.startsWith('0x') ? packedHex.slice(2) : packedHex)
    : '';
  if (!raw || raw.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Walk packed MultiSend bytes into inner call records.
 *
 * @param {string | Uint8Array} packedHex
 * @returns {Array<{ operation: number, to: string, value: bigint, data: string }>}
 */
export function decodeMultiSend(packedHex) {
  const buf = toBytes(packedHex);
  if (buf.length === 0 || buf.length > MAX_BYTES) return [];

  const ops = [];
  let offset = 0;

  try {
    while (offset < buf.length) {
      if (offset + 1 + 20 + 32 + 32 > buf.length) return [];

      const operation = buf[offset];
      offset += 1;

      const toBytes20 = buf.slice(offset, offset + 20);
      offset += 20;
      const to = `0x${Array.from(toBytes20, b => b.toString(16).padStart(2, '0')).join('')}`;

      let value = 0n;
      for (let i = 0; i < 32; i++) {
        value = (value << 8n) | BigInt(buf[offset + i]);
      }
      offset += 32;

      let dataLen = 0n;
      for (let i = 0; i < 32; i++) {
        dataLen = (dataLen << 8n) | BigInt(buf[offset + i]);
      }
      offset += 32;

      if (dataLen > BigInt(MAX_BYTES) || dataLen > BigInt(buf.length - offset)) return [];

      const dataLenNum = Number(dataLen);
      if (dataLenNum < 0 || offset + dataLenNum > buf.length) return [];

      const data = bytesToHex(buf.slice(offset, offset + dataLenNum));
      offset += dataLenNum;

      ops.push({ operation, to, value, data });
    }
  } catch {
    return [];
  }

  return ops;
}
