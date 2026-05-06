/**
 * test/ssrf.test.js
 *
 * SSRF guard tests for src/alert/webhook.js
 * Uses node:test + node:assert/strict — no external deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __ssrf } from '../src/alert/webhook.js';

const { isBlockedIP, isBlockedIPv4, isBlockedIPv6, ipv4ToBytes, validateWebhookUrl } = __ssrf;

// ---------------------------------------------------------------------------
// ipv4ToBytes — octal / leading-zero rejection
// ---------------------------------------------------------------------------

describe('ipv4ToBytes', () => {
  it('parses a normal address', () => {
    assert.deepEqual(ipv4ToBytes('192.168.1.1'), [192, 168, 1, 1]);
  });

  it('rejects leading-zero octal segment (010)', () => {
    assert.equal(ipv4ToBytes('010.0.0.1'), null);
  });

  it('rejects leading-zero segment (0177)', () => {
    assert.equal(ipv4ToBytes('0177.0.0.1'), null);
  });

  it('rejects five-segment address', () => {
    assert.equal(ipv4ToBytes('1.2.3.4.5'), null);
  });
});

// ---------------------------------------------------------------------------
// isBlockedIPv4 — blocked ranges
// ---------------------------------------------------------------------------

describe('isBlockedIPv4 — blocked', () => {
  const blocked = [
    ['127.0.0.1',       'loopback'],
    ['127.255.255.255', 'loopback /8 edge'],
    ['10.0.0.1',        'RFC1918 10/8'],
    ['10.255.255.255',  'RFC1918 10/8 edge'],
    ['172.16.0.1',      'RFC1918 172.16/12'],
    ['172.31.255.255',  'RFC1918 172.31 edge'],
    ['192.168.0.1',     'RFC1918 192.168/16'],
    ['192.168.255.255', 'RFC1918 192.168 edge'],
    ['169.254.0.1',     'link-local'],
    ['169.254.169.254', 'AWS IMDS'],
    ['100.64.0.1',      'CGNAT 100.64/10'],
    ['100.127.255.255', 'CGNAT edge'],
    ['224.0.0.1',       'multicast'],
    ['255.255.255.255', 'broadcast'],
  ];

  for (const [addr, label] of blocked) {
    it(`blocks ${addr} (${label})`, () => {
      const bytes = ipv4ToBytes(addr);
      assert.notEqual(bytes, null, `ipv4ToBytes should parse ${addr}`);
      assert.equal(isBlockedIPv4(bytes), true);
    });
  }
});

describe('isBlockedIPv4 — allowed', () => {
  it('allows 1.1.1.1 (Cloudflare)', () => {
    assert.equal(isBlockedIPv4(ipv4ToBytes('1.1.1.1')), false);
  });

  it('allows 8.8.8.8 (Google DNS)', () => {
    assert.equal(isBlockedIPv4(ipv4ToBytes('8.8.8.8')), false);
  });

  it('allows 93.184.216.34 (example.com)', () => {
    assert.equal(isBlockedIPv4(ipv4ToBytes('93.184.216.34')), false);
  });
});

// ---------------------------------------------------------------------------
// isBlockedIPv6
// ---------------------------------------------------------------------------

describe('isBlockedIPv6 — blocked', () => {
  it('blocks ::1 (loopback)', () => {
    assert.equal(isBlockedIPv6('::1'), true);
  });

  it('blocks :: (unspecified)', () => {
    assert.equal(isBlockedIPv6('::'), true);
  });

  it('blocks ::ffff:127.0.0.1 (IPv4-mapped loopback)', () => {
    assert.equal(isBlockedIPv6('::ffff:127.0.0.1'), true);
  });

  it('blocks ::ffff:192.168.1.1 (IPv4-mapped RFC1918)', () => {
    assert.equal(isBlockedIPv6('::ffff:192.168.1.1'), true);
  });

  it('blocks 2002:7f00:1:: (6to4 loopback 127.0.0.1)', () => {
    assert.equal(isBlockedIPv6('2002:7f00:1::'), true);
  });

  it('blocks 64:ff9b::7f00:1 (NAT64 loopback)', () => {
    assert.equal(isBlockedIPv6('64:ff9b::7f00:1'), true);
  });

  it('blocks fc00::1 (ULA)', () => {
    assert.equal(isBlockedIPv6('fc00::1'), true);
  });

  it('blocks fe80::1 (link-local)', () => {
    assert.equal(isBlockedIPv6('fe80::1'), true);
  });

  it('blocks ff02::1 (multicast)', () => {
    assert.equal(isBlockedIPv6('ff02::1'), true);
  });
});

describe('isBlockedIPv6 — allowed', () => {
  it('allows 2606:4700:4700::1111 (Cloudflare DNS)', () => {
    assert.equal(isBlockedIPv6('2606:4700:4700::1111'), false);
  });
});

// ---------------------------------------------------------------------------
// isBlockedIP — unified entry point
// ---------------------------------------------------------------------------

describe('isBlockedIP', () => {
  it('blocks 127.0.0.1', () => assert.equal(isBlockedIP('127.0.0.1'), true));
  it('blocks ::1',       () => assert.equal(isBlockedIP('::1'), true));
  it('allows 1.1.1.1',   () => assert.equal(isBlockedIP('1.1.1.1'), false));
  it('returns false for non-IP (hostname)', () => assert.equal(isBlockedIP('example.com'), false));
});

// ---------------------------------------------------------------------------
// validateWebhookUrl — scheme, localhost, dry-run ordering
// ---------------------------------------------------------------------------

describe('validateWebhookUrl', () => {
  it('rejects file:// scheme', async () => {
    const r = await validateWebhookUrl('file:///etc/passwd');
    assert.equal(r.ok, false);
    assert.match(r.error, /scheme not allowed/i);
  });

  it('rejects gopher:// scheme', async () => {
    const r = await validateWebhookUrl('gopher://evil.example/');
    assert.equal(r.ok, false);
    assert.match(r.error, /scheme not allowed/i);
  });

  it('rejects javascript: scheme', async () => {
    const r = await validateWebhookUrl('javascript:alert(1)');
    assert.equal(r.ok, false);
  });

  it('rejects bare "localhost"', async () => {
    const r = await validateWebhookUrl('http://localhost/webhook');
    assert.equal(r.ok, false);
    assert.match(r.error, /localhost/i);
  });

  it('rejects 127.0.0.1 IP literal', async () => {
    const r = await validateWebhookUrl('http://127.0.0.1/webhook');
    assert.equal(r.ok, false);
    assert.match(r.error, /blocked range/i);
  });

  it('rejects 169.254.169.254 (AWS IMDS)', async () => {
    const r = await validateWebhookUrl('http://169.254.169.254/latest/meta-data/');
    assert.equal(r.ok, false);
    assert.match(r.error, /blocked range/i);
  });

  it('rejects RFC1918 10.x IP literal', async () => {
    const r = await validateWebhookUrl('https://10.0.0.1/hook');
    assert.equal(r.ok, false);
  });

  it('rejects ::1 IPv6 literal', async () => {
    const r = await validateWebhookUrl('http://[::1]/webhook');
    assert.equal(r.ok, false);
  });

  it('rejects malformed URL', async () => {
    const r = await validateWebhookUrl('not a url');
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid webhook url/i);
  });

  it('SSRF validation runs before dry-run short-circuit', async () => {
    // Import postWebhook to exercise the real call path with dryRun:true
    const { postWebhook } = await import('../src/alert/webhook.js');
    const r = await postWebhook('http://127.0.0.1/hook', {}, { dryRun: true });
    // Must be rejected (ok:false) even though dryRun is true
    assert.equal(r.ok, false, 'SSRF guard must fire before dryRun short-circuit');
    assert.match(r.error, /blocked range/i);
  });
});
