/**
 * src/alert/webhook.js
 *
 * POST a JSON payload to a webhook URL with retry and exponential backoff.
 * Up to 3 attempts total (2 retries). 4xx responses are not retried.
 * 10s timeout per attempt via AbortController.
 *
 * SSRF hardening:
 *  - URL must parse via `new URL()`.
 *  - Scheme must be http: or https: (blocks file:, gopher:, data:, ...).
 *  - IP literals in loopback / RFC1918 / link-local (incl. 169.254/16 IMDS) /
 *    CGNAT / multicast / reserved ranges are rejected for both IPv4 and IPv6.
 *  - Hostnames are resolved via DNS; any resolved address in a blocked range
 *    causes rejection.
 *  - Validation errors are not retried.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1500, 4500];

/**
 * @typedef {{
 *   ok: boolean,
 *   status?: number,
 *   error?: string,
 *   attempts: number,
 *   dryRun?: boolean,
 * }} WebhookResult
 */

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/**
 * Parse a dotted-quad IPv4 string into 4 bytes. Returns null on invalid input.
 * Leading zeros (e.g. "010") are intentionally rejected — they're octal-
 * ambiguous and a classic SSRF bypass.
 *
 * @param {string} ip
 * @returns {number[] | null}
 */
function ipv4ToBytes(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === '0') return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

/**
 * True for IPv4 addresses that must never be reached from a webhook:
 * 0/8, 10/8, 127/8, 169.254/16 (link-local + IMDS), 172.16/12, 192.168/16,
 * 100.64/10 (CGNAT), 224/4 (multicast), 240/4 (reserved + 255.255.255.255),
 * plus IETF/TEST-NET (192.0.0.0/24, 192.0.2.0/24, 198.51.100.0/24,
 * 203.0.113.0/24) and 198.18.0.0/15 (benchmarking).
 *
 * @param {number[]} bytes
 * @returns {boolean}
 */
function isBlockedIPv4(bytes) {
  const [a, b, c] = bytes;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  // IETF + TEST-NET-{1,2,3}
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  // Benchmarking 198.18/15
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/**
 * Expand any valid IPv6 textual form into 8 16-bit integers. Handles `::`
 * compaction and trailing IPv4-in-IPv6 (`::ffff:a.b.c.d`). Returns null on
 * malformed input — which shouldn't happen because callers already passed
 * `node:net.isIP() === 6`.
 *
 * @param {string} ip
 * @returns {number[] | null}
 */
function expandIPv6(ip) {
  let s = ip.toLowerCase();

  // Convert trailing dotted-IPv4 (::ffff:127.0.0.1) into two hex groups.
  const v4Match = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const bytes = ipv4ToBytes(v4Match[2]);
    if (!bytes) return null;
    const h1 = (bytes[0] << 8) | bytes[1];
    const h2 = (bytes[2] << 8) | bytes[3];
    s = v4Match[1] + h1.toString(16) + ':' + h2.toString(16);
  }

  let groups;
  const dblIdx = s.indexOf('::');
  if (dblIdx !== -1) {
    if (s.indexOf('::', dblIdx + 1) !== -1) return null;
    const headStr = s.slice(0, dblIdx);
    const tailStr = s.slice(dblIdx + 2);
    const headParts = headStr ? headStr.split(':') : [];
    const tailParts = tailStr ? tailStr.split(':') : [];
    const fill = 8 - headParts.length - tailParts.length;
    if (fill < 0) return null;
    groups = [...headParts, ...Array(fill).fill('0'), ...tailParts];
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;

  const out = new Array(8);
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out[i] = parseInt(g, 16);
  }
  return out;
}

/**
 * True for IPv6 addresses that must never be reached:
 * - ::/128 (unspecified), ::1/128 (loopback)
 * - fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 (multicast)
 * - IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) where embedded
 *   IPv4 is in a blocked range — handles dotted *and* hex-encoded forms
 *   (e.g. ::ffff:7f00:1 == 127.0.0.1).
 * - 6to4 (2002::/16) and NAT64 (64:ff9b::/96) where embedded IPv4 is blocked.
 *
 * @param {string} ip — already validated as IPv6 by node:net.isIP
 * @returns {boolean}
 */
function isBlockedIPv6(ip) {
  const g = expandIPv6(ip);
  if (!g) return false;

  const head6Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  const head5Zero = head6Zero || (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0);

  // ::/128 and ::1/128
  if (head6Zero && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;

  // IPv4-mapped ::ffff:0:0/96 — extract embedded IPv4 and check.
  if (head5Zero && g[5] === 0xffff) {
    const v4 = [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff];
    if (isBlockedIPv4(v4)) return true;
  }

  // IPv4-compatible ::/96 (deprecated but still routable on some stacks).
  if (head6Zero && !(g[6] === 0 && g[7] <= 1)) {
    const v4 = [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff];
    if (isBlockedIPv4(v4)) return true;
  }

  // 6to4 2002::/16 — embedded IPv4 in g[1], g[2].
  if (g[0] === 0x2002) {
    const v4 = [(g[1] >> 8) & 0xff, g[1] & 0xff, (g[2] >> 8) & 0xff, g[2] & 0xff];
    if (isBlockedIPv4(v4)) return true;
  }

  // NAT64 64:ff9b::/96 — embedded IPv4 in g[6], g[7].
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const v4 = [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff];
    if (isBlockedIPv4(v4)) return true;
  }

  // fc00::/7 ULA, fe80::/10 link-local, ff00::/8 multicast.
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * Check whether a literal IP string is in a blocked range.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIP(ip) {
  const family = isIP(ip);
  if (family === 4) {
    const bytes = ipv4ToBytes(ip);
    return bytes ? isBlockedIPv4(bytes) : true;
  }
  if (family === 6) return isBlockedIPv6(ip);
  return false;
}

/**
 * Validate a webhook URL against SSRF risks. Resolves DNS for hostnames so
 * `--webhook http://internal.local/...` can't smuggle a private IP behind a
 * public-looking name.
 *
 * The returned `validatedIPs` is what the caller should pin the actual TCP
 * connection to — preventing a DNS rebinding TOCTOU between this check and
 * the subsequent POST.
 *
 * @param {string} rawUrl
 * @returns {Promise<
 *   | { ok: true, host: string, port: number, family: 4 | 6, validatedIPs: string[] }
 *   | { ok: false, error: string }
 * >}
 */
async function validateWebhookUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid webhook URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: `Webhook scheme not allowed: ${parsed.protocol} (only http:/https:)`,
    };
  }

  // URL hostname strips IPv6 brackets internally but keeps lowercase.
  // For an IPv6 literal `parsed.hostname` is the address without brackets.
  const host = parsed.hostname;
  if (!host) {
    return { ok: false, error: 'Webhook URL missing host' };
  }

  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);

  // IP literal? Validate directly.
  const literalFamily = isIP(host);
  if (literalFamily) {
    if (isBlockedIP(host)) {
      return { ok: false, error: `Webhook host in blocked range: ${host}` };
    }
    return { ok: true, host, port, family: literalFamily, validatedIPs: [host] };
  }

  // Hostname: refuse bare "localhost" plus DNS-resolve and check every address.
  if (host.toLowerCase() === 'localhost') {
    return { ok: false, error: 'Webhook host in blocked range: localhost' };
  }

  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    return {
      ok: false,
      error: `Webhook host could not be resolved: ${err?.message ?? String(err)}`,
    };
  }
  if (!addrs.length) {
    return { ok: false, error: `Webhook host has no addresses: ${host}` };
  }
  for (const { address } of addrs) {
    if (isBlockedIP(address)) {
      return {
        ok: false,
        error: `Webhook host ${host} resolves to blocked address ${address}`,
      };
    }
  }

  // All resolved addresses passed the blocklist; pin the connection to one of
  // them later so a rebinding DNS response can't redirect us to a private IP.
  const validatedIPs = addrs.map(a => a.address);
  const family = /** @type {4 | 6} */ (addrs[0].family);
  return { ok: true, host, port, family, validatedIPs };
}

// Exported for tests; not part of the public CLI surface.
export const __ssrf = {
  ipv4ToBytes,
  isBlockedIPv4,
  isBlockedIPv6,
  isBlockedIP,
  validateWebhookUrl,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue one POST attempt with the TCP connection pinned to a pre-validated IP.
 * Returns a non-throwing envelope; transport errors become `{ ok:false, error }`.
 *
 * @param {{ url: string, ip: string, family: 4 | 6, body: string, timeoutMs: number }} args
 * @returns {Promise<{ ok: true, status: number } | { ok: false, error: string }>}
 */
function makeRequest({ url, ip, family, body, timeoutMs }) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = Number(parsed.port) || (isHttps ? 443 : 80);

  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    const req = lib.request({
      method: 'POST',
      hostname: parsed.hostname,
      port,
      path: (parsed.pathname || '/') + parsed.search,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body).toString(),
        host: parsed.host,
      },
      // Pin the underlying socket to the IP we already validated. Even if
      // the system resolver now returns a private address (DNS rebinding),
      // the connection still goes to the originally-resolved public IP.
      lookup: (_h, _o, cb) => cb(null, ip, family),
      // TLS uses SNI + cert verification against the original hostname.
      servername: parsed.hostname,
      signal: controller.signal,
    }, (res) => {
      // Drain the body so the socket can close cleanly; we don't need it.
      res.on('data', () => {});
      res.on('end', () => settle({ ok: true, status: res.statusCode ?? 0 }));
      res.on('error', (err) => settle({ ok: false, error: err?.message ?? String(err) }));
    });
    req.on('error', (err) => settle({ ok: false, error: err?.message ?? String(err) }));
    req.end(body);
  });
}

/**
 * POST JSON payload to a webhook URL.
 *
 * @param {string} url
 * @param {object} payload
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<WebhookResult>}
 */
export async function postWebhook(url, payload, { dryRun = false } = {}) {
  const validation = await validateWebhookUrl(url);
  if (!validation.ok) {
    return { ok: false, error: validation.error, attempts: 0 };
  }

  if (dryRun) {
    return { ok: true, attempts: 0, dryRun: true };
  }

  const body = JSON.stringify(payload);
  const pinnedIp = validation.validatedIPs[0];
  const family = validation.family;

  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await makeRequest({ url, ip: pinnedIp, family, body, timeoutMs: 10_000 });

    if (res.ok) {
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, status: res.status, attempts: attempt };
      }
      // 4xx: don't retry
      if (res.status >= 400 && res.status < 500) {
        return {
          ok: false,
          status: res.status,
          error: `HTTP ${res.status} — not retrying 4xx`,
          attempts: attempt,
        };
      }
      // 3xx (redirect not followed) or 5xx: retry if attempts remain
      lastError = `HTTP ${res.status}`;
    } else {
      lastError = res.error;
    }

    // Wait before next attempt (no wait after last attempt)
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, BACKOFF_MS[attempt - 1]));
    }
  }

  return {
    ok: false,
    status: lastStatus ?? undefined,
    error: lastError ?? 'Unknown error',
    attempts: MAX_ATTEMPTS,
  };
}
