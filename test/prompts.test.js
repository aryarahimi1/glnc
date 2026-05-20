/**
 * test/prompts.test.js
 *
 * Coverage for the zero-dep prompt library — focused on the parts that
 * silently corrupted user input before v1.0.10:
 *   - CSI escape parsing (plain arrows, modifiers, Home/End, PgUp/PgDn, ~ keys)
 *   - Split-chunk safety (ESC arriving without its tail, lone Esc disambiguation)
 *   - Tab key (added to support the new safe `acceptPlaceholder` flow)
 *   - outputOpts mapping for the interactive REPL
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseKeys, createKeyReader } from '../src/cli/prompts.js';
import { outputOpts } from '../src/cli/interactive.js';

// ---------------------------------------------------------------------------
// parseKeys — basic keys
// ---------------------------------------------------------------------------

describe('parseKeys — basic keys', () => {
  it('parses Enter, backspace, ctrl-c, ctrl-d, tab', () => {
    const { keys, remainder } = parseKeys('\r\x7f\x03\x04\x09');
    assert.deepEqual(
      keys.map(k => k.type),
      ['enter', 'backspace', 'ctrl-c', 'ctrl-d', 'tab'],
    );
    assert.equal(remainder, '');
  });

  it('parses printable chars as char events with their value', () => {
    const { keys } = parseKeys('hi!');
    assert.deepEqual(keys, [
      { type: 'char', value: 'h' },
      { type: 'char', value: 'i' },
      { type: 'char', value: '!' },
    ]);
  });

  it('skips unhandled control bytes (no garbage leaks)', () => {
    // 0x0b = VT, 0x10 = DLE — both control bytes we don't bind
    const { keys } = parseKeys('a\x0bb\x10c');
    assert.deepEqual(keys.map(k => k.value), ['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// parseKeys — CSI / arrow keys
// ---------------------------------------------------------------------------

describe('parseKeys — CSI sequences', () => {
  it('parses plain arrow keys', () => {
    const { keys } = parseKeys('\x1b[A\x1b[B\x1b[C\x1b[D');
    assert.deepEqual(keys.map(k => k.type), ['up', 'down', 'right', 'left']);
  });

  it('parses Home/End via [H/[F', () => {
    const { keys } = parseKeys('\x1b[H\x1b[F');
    assert.deepEqual(keys.map(k => k.type), ['home', 'end']);
  });

  it('parses PgUp/PgDn/Home/End/Del via [N~ form', () => {
    // ESC[1~ Home, ESC[3~ Del, ESC[4~ End, ESC[5~ PgUp, ESC[6~ PgDn
    const { keys } = parseKeys('\x1b[1~\x1b[3~\x1b[4~\x1b[5~\x1b[6~');
    assert.deepEqual(
      keys.map(k => k.type),
      ['home', 'delete', 'end', 'pageup', 'pagedown'],
    );
  });

  it('handles modifier-laden CSI without leaking the modifier digits', () => {
    // Ctrl+Right = ESC [ 1 ; 5 C  — the bug was that '1;5' leaked as text.
    const { keys } = parseKeys('\x1b[1;5C');
    assert.deepEqual(keys, [{ type: 'right' }]);
  });

  it('parses SS3 arrow form (ESC O <final>)', () => {
    const { keys } = parseKeys('\x1bOA\x1bOB');
    assert.deepEqual(keys.map(k => k.type), ['up', 'down']);
  });

  it('does not leak the tail of an unknown CSI final byte', () => {
    // ESC [ 99 X — completely unknown; should be dropped silently, not as chars.
    const { keys } = parseKeys('\x1b[99X');
    assert.equal(keys.length, 0);
  });
});

// ---------------------------------------------------------------------------
// parseKeys — split-chunk safety
// ---------------------------------------------------------------------------

describe('parseKeys — partial sequences become remainder', () => {
  it('lone ESC at end of chunk is held as remainder, not emitted', () => {
    const { keys, remainder } = parseKeys('abc\x1b');
    assert.deepEqual(keys.map(k => k.value), ['a', 'b', 'c']);
    assert.equal(remainder, '\x1b');
  });

  it('ESC [ at end of chunk is held as remainder', () => {
    const { keys, remainder } = parseKeys('x\x1b[');
    assert.deepEqual(keys.map(k => k.value), ['x']);
    assert.equal(remainder, '\x1b[');
  });

  it('ESC [ with partial params (no final byte yet) is held as remainder', () => {
    const { keys, remainder } = parseKeys('\x1b[1;5');
    assert.equal(keys.length, 0);
    assert.equal(remainder, '\x1b[1;5');
  });
});

// ---------------------------------------------------------------------------
// createKeyReader — buffers across chunks, disambiguates lone Esc
// ---------------------------------------------------------------------------

describe('createKeyReader', () => {
  it('joins a split arrow key sequence across two feeds', () => {
    const reader = createKeyReader();
    const collected = [];
    reader.feed('\x1b', ks => collected.push(...ks));
    assert.deepEqual(collected, [], 'lone ESC must not emit yet');
    reader.feed('[A', ks => collected.push(...ks));
    assert.deepEqual(collected, [{ type: 'up' }]);
    reader.dispose();
  });

  it('emits Esc after the timeout when no continuation arrives', async () => {
    const reader = createKeyReader({ escTimeoutMs: 10 });
    const collected = [];
    reader.feed('\x1b', ks => collected.push(...ks));
    assert.deepEqual(collected, []);

    await new Promise(r => setTimeout(r, 25));

    assert.deepEqual(collected, [{ type: 'esc' }]);
    reader.dispose();
  });

  it('does NOT emit a spurious Esc when ESC[1;5C arrives split across reads', async () => {
    // This is the SSH/PTY bug — Ctrl+Right used to fire a cancel + leak `1;5C`.
    const reader = createKeyReader({ escTimeoutMs: 50 });
    const collected = [];
    reader.feed('\x1b', ks => collected.push(...ks));
    reader.feed('[1;5C', ks => collected.push(...ks));
    assert.deepEqual(collected, [{ type: 'right' }]);
    reader.dispose();
  });

  it('dispose cancels a pending Esc flush', async () => {
    const reader = createKeyReader({ escTimeoutMs: 10 });
    const collected = [];
    reader.feed('\x1b', ks => collected.push(...ks));
    reader.dispose();
    await new Promise(r => setTimeout(r, 25));
    assert.deepEqual(collected, [], 'dispose must cancel the pending Esc timer');
  });
});

// ---------------------------------------------------------------------------
// outputOpts — interactive REPL ↔ run* contract
// ---------------------------------------------------------------------------

describe('outputOpts', () => {
  it('pretty mode returns no machine flags', () => {
    assert.deepEqual(outputOpts('pretty'), {});
  });

  it('json mode returns { json: true }', () => {
    assert.deepEqual(outputOpts('json'), { json: true });
  });

  it('ndjson mode returns BOTH json and ndjson (matches --ndjson CLI contract)', () => {
    // The pre-1.0.10 bug returned { json: true } for ndjson, so NDJSON output
    // in the REPL was silently the same as --json. run* functions that gate
    // on either flag now stay consistent.
    assert.deepEqual(outputOpts('ndjson'), { json: true, ndjson: true });
  });
});
