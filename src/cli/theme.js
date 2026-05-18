/**
 * src/cli/theme.js
 *
 * Central color / style definitions for the glnc CLI.
 * ALL ANSI escape codes live here — nowhere else in the codebase should
 * contain raw \x1b[ color/style sequences.
 *
 * Cursor-control escapes (move-up, clear-to-EOL) used in the multi-line
 * spinner are the only permitted \x1b[ sequences outside this file.
 */

// ---------------------------------------------------------------------------
// Color enabled detection
// ---------------------------------------------------------------------------

function detectColorEnabled() {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.NO_COLOR) return false;
  if (process.argv.includes('--no-color') || process.argv.includes('--no-colour')) return false;
  if (process.argv.includes('--json') || process.argv.includes('--ndjson')) return false;
  return process.stdout.isTTY ?? false;
}

const COLOR_ENABLED = detectColorEnabled();

/**
 * Detect whether the terminal supports 24-bit truecolor.
 * Falls back to false when COLOR_ENABLED is false.
 *
 * @returns {boolean}
 */
function detectTruecolor() {
  if (!COLOR_ENABLED) return false;
  const ct = process.env.COLORTERM;
  return ct === 'truecolor' || ct === '24bit';
}

const TRUECOLOR = detectTruecolor();

// ---------------------------------------------------------------------------
// Primitive wrappers
// ---------------------------------------------------------------------------

/**
 * Build a wrap function for standard SGR codes.
 *
 * @param {number} open
 * @param {number} close
 * @returns {(s: string) => string}
 */
function wrap(open, close) {
  return COLOR_ENABLED
    ? s => `\x1b[${open}m${s}\x1b[${close}m`
    : s => String(s);
}

/**
 * 256-color foreground.
 *
 * @param {number} n  - 0–255
 * @returns {(s: string) => string}
 */
function fg256(n) {
  return COLOR_ENABLED
    ? s => `\x1b[38;5;${n}m${s}\x1b[0m`
    : s => String(s);
}

/**
 * 256-color background.
 *
 * @param {number} n  - 0–255
 * @returns {(s: string) => string}
 */
function bg256(n) {
  return COLOR_ENABLED
    ? s => `\x1b[48;5;${n}m${s}\x1b[0m`
    : s => String(s);
}

/**
 * 24-bit truecolor foreground.
 * When truecolor is not supported, falls back to the provided fg256 fallback.
 *
 * @param {number} r  - 0–255
 * @param {number} g  - 0–255
 * @param {number} b  - 0–255
 * @param {number} [fallback256]  - 256-color index to use when truecolor is unavailable
 * @returns {(s: string) => string}
 */
function rgb(r, g, b, fallback256) {
  if (!COLOR_ENABLED) return s => String(s);
  if (TRUECOLOR) return s => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
  if (fallback256 !== undefined) return fg256(fallback256);
  return s => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

/**
 * 24-bit truecolor background.
 * When truecolor is not supported, falls back to the provided bg256 fallback.
 *
 * @param {number} r  - 0–255
 * @param {number} g  - 0–255
 * @param {number} b  - 0–255
 * @param {number} [fallback256]  - 256-color index to use when truecolor is unavailable
 * @returns {(s: string) => string}
 */
function bgRgb(r, g, b, fallback256) {
  if (!COLOR_ENABLED) return s => String(s);
  if (TRUECOLOR) return s => `\x1b[48;2;${r};${g};${b}m${s}\x1b[0m`;
  if (fallback256 !== undefined) return bg256(fallback256);
  return s => `\x1b[48;2;${r};${g};${b}m${s}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Exported color helpers (c)
// ---------------------------------------------------------------------------

/** @type {Record<string, any>} */
export const c = {
  red:     wrap(31, 0),
  green:   wrap(32, 0),
  yellow:  wrap(33, 0),
  blue:    wrap(34, 0),
  magenta: wrap(35, 0),
  cyan:    wrap(36, 0),
  white:   wrap(37, 0),
  dim:     wrap(2, 0),
  bold:    wrap(1, 0),
  reset:   wrap(0, 0),
  fg256,
  bg256,
  rgb,
  bgRgb,
};

// ---------------------------------------------------------------------------
// Brand colors
// ---------------------------------------------------------------------------

/** Vibrant teal — primary brand color. rgb(0, 212, 170) / 256-color fallback 43 */
const brand    = rgb(0, 212, 170, 43);

/** Muted teal — secondary brand color. rgb(0, 140, 110) / 256-color fallback 36 */
const brandDim = rgb(0, 140, 110, 36);

/** Warm amber — accent/highlight color. rgb(251, 191, 36) / 256-color fallback 220 */
const gold     = rgb(251, 191, 36, 220);

// ---------------------------------------------------------------------------
// Semantic theme
// ---------------------------------------------------------------------------

export const theme = {
  chain: {
    ethereum: bg256(240),
    polygon:  bg256(99),
    arbitrum: bg256(27),
    base:     bg256(26),
    optimism: bg256(160),
    zksync:   bg256(105),
    linea:    bg256(22),
    solana:   bg256(35),
    bitcoin:  bg256(208),
  },
  status: {
    ok:      c.green,
    fail:    c.red,
    pending: c.yellow,
  },
  role: {
    primary:   c.bold,
    secondary: c.white,
    muted:     c.dim,
    accent:    brand,
  },
  movement: {
    in:      c.green,
    out:     c.red,
    approve: c.yellow,
  },
  brand,
  brandDim,
  gold,
};

// ---------------------------------------------------------------------------
// Chain badge helper
// ---------------------------------------------------------------------------

/** Glyph per chain */
const CHAIN_GLYPH = {
  ethereum: '⬢',
  polygon:  '⬡',
  arbitrum: '◆',
  base:     '▲',
  optimism: '◉',
  zksync:   '⟁',
  linea:    '⬣',
  solana:   '◎',
  bitcoin:  '₿',
};

/**
 * Build a 256-color background badge for the given chain name.
 * Format: <bg><bold><white> GLYPH NAME <reset>
 *
 * @param {string} name  - canonical chain name (lowercase)
 * @returns {string}
 */
export function chainBadge(name) {
  const key   = name.toLowerCase();
  const glyph = CHAIN_GLYPH[key] ?? '●';
  const label = ` ${glyph} ${name.toUpperCase()} `;

  if (!COLOR_ENABLED) return label.trim();

  const bgCode  = {
    ethereum: 240, polygon: 99, arbitrum: 27, base: 26,
    optimism: 160, zksync: 105, linea: 22,
    solana: 35, bitcoin: 208,
  }[key] ?? 240;
  // bold + white fg + bg256 + reset
  return `\x1b[48;5;${bgCode}m\x1b[1m\x1b[97m${label}\x1b[0m`;
}
