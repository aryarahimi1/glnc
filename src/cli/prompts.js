/**
 * src/cli/prompts.js
 *
 * Tiny TUI prompt library — zero dependencies, Bun-friendly.
 * Inspired by the look-and-feel of Ink-based CLIs (Claude Code, Vercel, etc.).
 *
 * Exports:
 *   box(lines, opts)              => string  (rounded-border box)
 *   select({ message, choices })  => Promise<value>
 *   input({ message, ... })       => Promise<string>
 *   CancelledError                — thrown on Ctrl+C / Ctrl+D
 */

import { c, theme } from './render.js';

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const stdout = process.stdout;
const stdin = process.stdin;

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function visibleLen(s) {
  return s.replace(ANSI_RE, '').length;
}

function write(s) { stdout.write(s); }
function clearLine() { write('\r\x1b[2K'); }
function moveUp(n) { if (n > 0) write(`\x1b[${n}A`); }
function hideCursor() { write('\x1b[?25l'); }
function showCursor() { write('\x1b[?25h'); }

export class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; }
}

/**
 * Parse a raw stdin chunk into discrete logical keys plus any trailing
 * partial escape sequence that should be carried into the next chunk.
 *
 * Each entry in `keys` is one of:
 *   { type: 'up' | 'down' | 'left' | 'right' | 'enter' | 'backspace'
 *           | 'tab' | 'ctrl-c' | 'ctrl-d' | 'esc' | 'char',
 *     value?: string }
 *
 * `remainder` is a string of bytes the caller MUST prepend to the next chunk
 * before parsing again. This is what makes split-chunk escape sequences
 * (a real hazard over SSH/PTY where ESC arrives in one read and `[A` in the
 * next) safe — without it, a lone ESC at the chunk tail would fire a spurious
 * cancel and the trailing `[A` would leak into the input buffer as text.
 *
 * @param {string} data
 * @returns {{ keys: Array<{type: string, value?: string}>, remainder: string }}
 */
export function parseKeys(data) {
  const keys = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    const code = data.charCodeAt(i);

    if (code === 0x03)      { keys.push({ type: 'ctrl-c' }); i++; continue; }
    if (code === 0x04)      { keys.push({ type: 'ctrl-d' }); i++; continue; }
    if (code === 0x09)      { keys.push({ type: 'tab' }); i++; continue; }
    if (code === 0x0d || code === 0x0a) { keys.push({ type: 'enter' }); i++; continue; }
    if (code === 0x7f || code === 0x08) { keys.push({ type: 'backspace' }); i++; continue; }

    if (code === 0x1b) {
      // A bare ESC at the very end of a chunk is ambiguous — it might be a
      // standalone Esc keypress or the prefix of a CSI/SS3 sequence whose
      // tail is in the next chunk. Buffer it and let the caller decide.
      if (i === data.length - 1) {
        return { keys, remainder: '\x1b' };
      }

      const next = data[i + 1];

      // SS3 sequence: ESC O <final>  (some terminals send F1-F4 / arrows this way)
      if (next === 'O') {
        if (i + 2 >= data.length) {
          return { keys, remainder: data.slice(i) };
        }
        const final = data[i + 2];
        if      (final === 'A') keys.push({ type: 'up' });
        else if (final === 'B') keys.push({ type: 'down' });
        else if (final === 'C') keys.push({ type: 'right' });
        else if (final === 'D') keys.push({ type: 'left' });
        i += 3;
        continue;
      }

      // CSI sequence: ESC [ <params> <final>
      // Final byte is in the range 0x40–0x7E. We seek forward to find it; if
      // we never do (chunk truncated mid-sequence), buffer everything from
      // the ESC onward as remainder.
      if (next === '[') {
        let j = i + 2;
        while (j < data.length) {
          const fc = data.charCodeAt(j);
          if (fc >= 0x40 && fc <= 0x7e) break;
          j++;
        }
        if (j >= data.length) {
          return { keys, remainder: data.slice(i) };
        }

        const final = data[j];
        const params = data.slice(i + 2, j);

        // Plain arrows + a few common keys. Modifier-laden variants
        // (e.g. `1;5C` for Ctrl+Right) are recognized as their base key —
        // the modifier digits are silently discarded but no longer leak.
        if      (final === 'A') keys.push({ type: 'up' });
        else if (final === 'B') keys.push({ type: 'down' });
        else if (final === 'C') keys.push({ type: 'right' });
        else if (final === 'D') keys.push({ type: 'left' });
        else if (final === 'H') keys.push({ type: 'home' });
        else if (final === 'F') keys.push({ type: 'end' });
        else if (final === '~') {
          // ESC [ N ~  — Home (1), Ins (2), Del (3), End (4), PgUp (5), PgDn (6), …
          if      (params === '1' || params === '7') keys.push({ type: 'home' });
          else if (params === '3') keys.push({ type: 'delete' });
          else if (params === '4' || params === '8') keys.push({ type: 'end' });
          else if (params === '5') keys.push({ type: 'pageup' });
          else if (params === '6') keys.push({ type: 'pagedown' });
          // other tilde sequences: silently dropped
        }
        // any other CSI final byte: silently dropped (no leak)

        i = j + 1;
        continue;
      }

      // ESC followed by some other byte — treat as bare Esc and let the
      // following byte be reprocessed on the next iteration.
      keys.push({ type: 'esc' });
      i++;
      continue;
    }

    // Skip other control bytes (Ctrl+letter we don't handle, etc.)
    if (code < 32) { i++; continue; }

    keys.push({ type: 'char', value: ch });
    i++;
  }
  return { keys, remainder: '' };
}

/**
 * Stateful wrapper around parseKeys that buffers partial escape sequences
 * across multiple stdin data events and disambiguates a lone ESC keypress
 * from the prefix of a sequence whose tail is still on the wire.
 *
 * Usage:
 *   const reader = createKeyReader();
 *   stdin.on('data', buf => reader.feed(buf.toString(), keys => { ... }));
 *   // on teardown:
 *   reader.dispose();
 *
 * If a chunk ends with a bare ESC, the reader holds it for `escTimeoutMs`
 * and only emits `{ type: 'esc' }` if no continuation byte arrives. This is
 * how every serious TUI (readline, ncurses, prompt-toolkit) handles the
 * Esc/CSI ambiguity.
 *
 * @param {{ escTimeoutMs?: number }} [opts]
 */
export function createKeyReader(opts = {}) {
  const escTimeoutMs = opts.escTimeoutMs ?? 50;
  let pending = '';
  let pendingTimer = null;
  let lastEmit = null;

  const clearPendingTimer = () => {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  };

  return {
    feed(data, onKeys) {
      lastEmit = onKeys;
      clearPendingTimer();

      const combined = pending + data;
      const { keys, remainder } = parseKeys(combined);
      pending = remainder;

      if (keys.length) onKeys(keys);

      // If we're left holding a lone ESC, arm a short timeout to flush it
      // as a real Esc keypress. Any new bytes within the window cancel the
      // timer and re-parse with the buffered ESC prepended.
      if (pending === '\x1b') {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          if (pending === '\x1b' && lastEmit) {
            pending = '';
            lastEmit([{ type: 'esc' }]);
          }
        }, escTimeoutMs);
      }
    },
    dispose() {
      clearPendingTimer();
      pending = '';
      lastEmit = null;
    },
  };
}

function ensureTTY() {
  if (!stdin.isTTY) throw new Error('Interactive prompts require a TTY');
}

let cleanupInstalled = false;
function installGlobalCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const restore = () => {
    try { stdin.setRawMode(false); } catch {}
    showCursor();
  };
  process.on('exit', restore);
}

// ---------------------------------------------------------------------------
// Rounded box
// ---------------------------------------------------------------------------

/**
 * Render a rounded-border box around the given lines. Returns a string;
 * caller decides where to print it.
 *
 * @param {string[]} lines           — already-styled content lines
 * @param {object} [opts]
 * @param {(s: string) => string} [opts.borderColor]  defaults to theme.brand
 * @param {number} [opts.paddingX=2]
 * @param {string} [opts.title]      — optional title centered on the top border
 * @returns {string}
 */
export function box(lines, opts = {}) {
  const borderColor = opts.borderColor ?? theme.brand;
  const paddingX = opts.paddingX ?? 2;

  const innerWidth = Math.max(...lines.map(visibleLen));
  const totalInner = innerWidth + paddingX * 2;
  const padX = ' '.repeat(paddingX);

  let top;
  if (opts.title) {
    // Build: ╭── TITLE ──╮
    // The title text sits between two dash segments, centered.
    const titleText = ' ' + opts.title + ' ';
    const titleLen = titleText.length;
    const dashTotal = totalInner - titleLen;
    const leftDashes = Math.floor(dashTotal / 2);
    const rightDashes = dashTotal - leftDashes;
    top = borderColor(
      '╭' +
      '─'.repeat(leftDashes) +
      titleText +
      '─'.repeat(rightDashes) +
      '╮'
    );
  } else {
    const horizontal = '─'.repeat(totalInner);
    top = borderColor('╭' + horizontal + '╮');
  }

  const bottom = borderColor('╰' + '─'.repeat(totalInner) + '╯');

  const middle = lines.map(line => {
    const trail = ' '.repeat(innerWidth - visibleLen(line));
    return borderColor('│') + padX + line + trail + padX + borderColor('│');
  });

  return [top, ...middle, bottom].join('\n');
}

// ---------------------------------------------------------------------------
// select — arrow-key menu
// ---------------------------------------------------------------------------

/**
 * @typedef {{ value: any, label: string, description?: string, icon?: string }} Choice
 *
 * @param {object} args
 * @param {string} args.message
 * @param {string} [args.hint]
 * @param {Choice[]} args.choices
 * @param {number} [args.initial=0]
 * @returns {Promise<any>}
 */
export async function select({ message, hint, choices, initial = 0 }) {
  ensureTTY();
  installGlobalCleanup();

  let index = Math.max(0, Math.min(initial, choices.length - 1));
  const labelWidth = Math.max(...choices.map(ch => visibleLen(ch.label)));
  const quitChoiceIdx = choices.findIndex(ch => ch.value === 'quit');

  const defaultHint = '↑/↓ move · Enter select · Esc cancel · Ctrl+C quit';
  const hintText = hint ?? defaultHint;

  const renderHeader = () => {
    const tag = theme.brand('›');
    const hintStr = ' ' + theme.brandDim('(' + hintText + ')');
    write(tag + ' ' + c.bold(message) + hintStr + '\n');
  };

  const renderChoices = (firstRender) => {
    if (!firstRender) moveUp(choices.length);
    for (let i = 0; i < choices.length; i++) {
      const ch = choices[i];
      const active = i === index;
      clearLine();

      const cursor = active ? theme.brand('›') + ' ' : '  ';
      const icon   = ch.icon ? (active ? theme.brand(ch.icon) : c.dim(ch.icon)) + ' ' : '';
      const pad    = ' '.repeat(labelWidth - visibleLen(ch.label));

      let label, desc;
      if (active) {
        label = c.bold(theme.brand(ch.label));
        desc  = ch.description ? '  ' + c.dim(ch.description) : '';
      } else {
        label = c.dim(ch.label);
        desc  = ch.description ? '  \x1b[2m' + c.dim(ch.description) + '\x1b[0m' : '';
      }

      write(cursor + icon + label + pad + desc + '\n');
    }
  };

  hideCursor();
  renderHeader();
  renderChoices(true);

  return new Promise((resolve, reject) => {
    const reader = createKeyReader();
    const finish = (resolveFn, value) => {
      reader.dispose();
      stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      stdin.pause();
      showCursor();
      resolveFn(value);
    };

    const handleKeys = (keys) => {
      for (const key of keys) {
        if (key.type === 'ctrl-c' || key.type === 'ctrl-d' || key.type === 'esc') {
          return finish(reject, new CancelledError());
        }
        if (key.type === 'up' || (key.type === 'char' && key.value === 'k')) {
          index = (index - 1 + choices.length) % choices.length;
          renderChoices(false);
          continue;
        }
        if (key.type === 'down' || (key.type === 'char' && key.value === 'j')) {
          index = (index + 1) % choices.length;
          renderChoices(false);
          continue;
        }
        if (key.type === 'home') {
          index = 0;
          renderChoices(false);
          continue;
        }
        if (key.type === 'end') {
          index = choices.length - 1;
          renderChoices(false);
          continue;
        }
        if (key.type === 'enter') {
          return finish(resolve, choices[index].value);
        }
        if (key.type === 'char') {
          // 'q' jumps to a Quit choice if one exists
          if ((key.value === 'q' || key.value === 'Q') && quitChoiceIdx >= 0) {
            index = quitChoiceIdx;
            return finish(resolve, choices[quitChoiceIdx].value);
          }
          // Digit jumps the cursor to that row but does NOT auto-submit —
          // a fat-finger on a destructive prompt (skip-dry-run, send-webhook)
          // should never resolve without an explicit Enter.
          const n = parseInt(key.value, 10);
          if (!isNaN(n) && n >= 1 && n <= choices.length) {
            index = n - 1;
            renderChoices(false);
            continue;
          }
        }
      }
    };

    const onData = (buf) => reader.feed(buf.toString(), handleKeys);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  }).then(
    v => v,
    err => { throw err; }
  );
}

// ---------------------------------------------------------------------------
// input — line input with placeholder
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.message
 * @param {string} [args.hint]
 * @param {string} [args.placeholder]
 * @param {string} [args.initial]
 * @param {boolean} [args.required]   if true, empty Enter is rejected with an inline notice
 * @param {boolean} [args.acceptPlaceholder]  if true, empty Enter resolves to the placeholder value
 * @returns {Promise<string>}
 */
export async function input({
  message,
  hint,
  placeholder = '',
  initial = '',
  required = false,
  acceptPlaceholder = false,
}) {
  ensureTTY();
  installGlobalCleanup();

  let buffer = initial;
  let errorMsg = '';

  const defaultHint = (acceptPlaceholder && placeholder)
    ? 'Type a value · Tab for default · Esc cancel'
    : 'Enter to submit · Esc cancel';
  const hintText = hint ?? defaultHint;

  const prefix =
    theme.brand('›') + ' ' + c.bold(message) +
    ' ' + theme.brandDim('(' + hintText + ')') + ' ';

  // We may render an extra error line under the prompt; track whether it's there
  // so we can clean it up before re-rendering or finishing.
  let errorLineShown = false;

  const clearErrorLine = () => {
    if (!errorLineShown) return;
    write('\n');             // step onto the error line
    clearLine();             // wipe it
    write('\x1b[1A');        // move back up
    errorLineShown = false;
  };

  const render = () => {
    clearErrorLine();
    clearLine();
    if (buffer.length === 0 && placeholder) {
      // Dim italic placeholder
      const styledPlaceholder = '\x1b[2m\x1b[3m' + placeholder + '\x1b[23m\x1b[0m';
      write(prefix + styledPlaceholder);
      const back = placeholder.length;
      if (back > 0) write(`\x1b[${back}D`);
    } else {
      write(prefix + buffer);
    }
    if (errorMsg) {
      // Save column, drop a line for the error, then come back
      write('\n  ' + c.dim('⚠ ') + c.dim(errorMsg));
      write('\x1b[1A');                    // move cursor back up to input line
      // restore horizontal position to end of buffer (or placeholder start)
      write('\r');
      const visible = buffer.length === 0 && placeholder ? 0 : buffer.length;
      write(`\x1b[${visibleLen(prefix) + visible}C`);
      errorLineShown = true;
    }
  };

  return new Promise((resolve, reject) => {
    const reader = createKeyReader();
    const finish = (fn, value) => {
      reader.dispose();
      clearErrorLine();
      stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      stdin.pause();
      write('\n');
      fn(value);
    };

    const handleKeys = (keys) => {
      let dirty = false;

      for (const key of keys) {
        if (key.type === 'ctrl-c' || key.type === 'esc') {
          return finish(reject, new CancelledError());
        }
        if (key.type === 'ctrl-d' && buffer.length === 0) {
          return finish(reject, new CancelledError());
        }
        if (key.type === 'enter') {
          // `required` always wins. If the buffer is empty, never auto-submit
          // the placeholder for a required field — the user must explicitly
          // type a value (or accept the placeholder by pressing Tab below).
          if (required && buffer.trim().length === 0) {
            errorMsg = 'value required — type something, Tab for placeholder, or Esc to cancel';
            dirty = true;
            continue;
          }
          if (buffer.length === 0 && acceptPlaceholder && placeholder) {
            return finish(resolve, placeholder);
          }
          return finish(resolve, buffer);
        }

        if (key.type === 'tab') {
          // Tab fills the buffer with the placeholder (still editable, still
          // submitted via Enter). Provides an explicit opt-in to use the
          // suggested default without the dangerous bare-Enter shortcut.
          if (buffer.length === 0 && placeholder) {
            buffer = placeholder;
            errorMsg = '';
            dirty = true;
          }
          continue;
        }

        if (key.type === 'backspace') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            errorMsg = '';
            dirty = true;
          }
          continue;
        }

        if (key.type === 'char') {
          buffer += key.value;
          errorMsg = '';
          dirty = true;
        }
        // ignore arrow keys, etc.
      }

      if (dirty) render();
    };

    const onData = (buf) => reader.feed(buf.toString(), handleKeys);

    stdin.setRawMode(true);
    stdin.resume();
    render();
    stdin.on('data', onData);
  }).then(
    v => v,
    err => { throw err; }
  );
}
