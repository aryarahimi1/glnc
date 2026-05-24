/**
 * test/index.warnings.test.js
 *
 * Unit tests for the disagreement-warning helpers in src/index.js:
 *   - shortProviderName
 *   - formatDisagreementWarning
 *   - maybeEmitDisagreementWarnings
 *
 * These helpers are exported from src/index.js via a small @internal named
 * export added at the end of that file solely to make testing possible.
 *
 * In a non-TTY test environment the color module (src/cli/theme.js) disables
 * ANSI wrapping, so `c.yellow('!')` returns the plain string '!'. All
 * pattern-match assertions are written to work with or without ANSI codes.
 *
 * Uses node:test + node:assert/strict — no external deps, no real RPCs.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  shortProviderName,
  formatDisagreementWarning,
  maybeEmitDisagreementWarnings,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// shortProviderName
// ---------------------------------------------------------------------------

describe('shortProviderName', () => {
  it('eth.llamarpc.com → llamarpc', () => {
    assert.equal(shortProviderName('https://eth.llamarpc.com'), 'llamarpc');
  });

  it('ethereum-rpc.publicnode.com → publicnode', () => {
    assert.equal(shortProviderName('https://ethereum-rpc.publicnode.com'), 'publicnode');
  });

  it('rpc.ankr.com → ankr', () => {
    assert.equal(shortProviderName('https://rpc.ankr.com/eth'), 'ankr');
  });

  it('arb1.arbitrum.io → arbitrum', () => {
    assert.equal(shortProviderName('https://arb1.arbitrum.io/rpc'), 'arbitrum');
  });

  it('mainnet.base.org → base', () => {
    assert.equal(shortProviderName('https://mainnet.base.org'), 'base');
  });

  it('polygon-bor-rpc.publicnode.com → publicnode', () => {
    assert.equal(shortProviderName('https://polygon-bor-rpc.publicnode.com'), 'publicnode');
  });

  it('mainnet.era.zksync.io → zksync', () => {
    assert.equal(shortProviderName('https://mainnet.era.zksync.io'), 'zksync');
  });

  it('not-a-url falls back to returning the raw string', () => {
    // shortProviderName catches URL parse errors and returns url verbatim
    const raw = 'not-a-url';
    assert.equal(shortProviderName(raw), raw);
  });

  it('empty string falls back to returning empty string', () => {
    // URL constructor throws for empty string → catch block returns url
    const result = shortProviderName('');
    assert.equal(result, '');
  });
});

// ---------------------------------------------------------------------------
// formatDisagreementWarning
// ---------------------------------------------------------------------------

/**
 * Build a minimal disagreement entry matching the shape that
 * buildDisagreementEntry produces and maybeEmitDisagreementWarnings consumes.
 */
function makeEntry({ chain = 'ethereum', agreement = 'majority', providers = [] } = {}) {
  return { chain, agreement, providers };
}

describe('formatDisagreementWarning', () => {
  it('balance flow — warning string contains "balance disagreement"', () => {
    const entry = makeEntry({
      chain: 'ethereum',
      agreement: 'majority',
      providers: [
        { url: 'https://eth.llamarpc.com/', value: '1.0', agreed: true },
        { url: 'https://rpc.ankr.com/',     value: '1.1', agreed: false },
      ],
    });
    const msg = formatDisagreementWarning(entry, 'balance');
    assert.ok(msg.includes('balance disagreement'), `expected "balance disagreement" in: ${msg}`);
  });

  it('transaction flow — warning string contains "transaction disagreement"', () => {
    const entry = makeEntry({
      chain: 'ethereum',
      agreement: 'majority',
      providers: [
        { url: 'https://eth.llamarpc.com/', value: '0xabc', agreed: true },
        { url: 'https://rpc.ankr.com/',     value: '0xdef', agreed: false },
      ],
    });
    const msg = formatDisagreementWarning(entry, 'transaction');
    assert.ok(msg.includes('transaction disagreement'), `expected "transaction disagreement" in: ${msg}`);
    assert.ok(!msg.includes('balance disagreement'), 'must not include "balance disagreement"');
  });

  it('chain name appears in the warning', () => {
    const entry = makeEntry({ chain: 'polygon', agreement: 'majority', providers: [
      { url: 'https://mainnet.base.org/', value: '5.0', agreed: true },
    ]});
    const msg = formatDisagreementWarning(entry, 'balance');
    assert.ok(msg.includes('polygon'), `expected chain name "polygon" in: ${msg}`);
  });

  it('agreement label appears at the end of the warning', () => {
    const entry = makeEntry({
      chain: 'ethereum',
      agreement: 'majority',
      providers: [{ url: 'https://eth.llamarpc.com/', value: '1.0', agreed: true }],
    });
    const msg = formatDisagreementWarning(entry, 'balance');
    assert.ok(msg.includes('majority'), `expected "majority" in: ${msg}`);
    assert.ok(msg.includes('using majority'), `expected "using majority" in: ${msg}`);
  });

  it('truncates long hex value (0x + 16+ chars) to 0xABCD…1234 form', () => {
    const longHex = '0xabcdef1234567890abcdef1234567890abcdef12';  // 42 chars
    const entry = makeEntry({
      chain: 'ethereum',
      agreement: 'majority',
      providers: [{ url: 'https://eth.llamarpc.com/', value: longHex, agreed: true }],
    });
    const msg = formatDisagreementWarning(entry, 'balance');
    // The hex is truncated to 0x + first 4 chars + ellipsis + last 4 chars
    assert.ok(msg.includes('…'), `long hex must be truncated with ellipsis in: ${msg}`);
    // The full hex string must NOT appear verbatim
    assert.ok(!msg.includes(longHex), 'full long hex must not appear verbatim in the warning');
  });

  it('short values (< 24 chars) appear verbatim', () => {
    const shortVal = '1.234567';
    const entry = makeEntry({
      chain: 'ethereum',
      agreement: 'majority',
      providers: [{ url: 'https://eth.llamarpc.com/', value: shortVal, agreed: true }],
    });
    const msg = formatDisagreementWarning(entry, 'balance');
    assert.ok(msg.includes(shortVal), `short value must appear verbatim in: ${msg}`);
  });

  it('null/undefined provider values are shown as dash and do not crash', () => {
    const entry = makeEntry({
      chain: 'ethereum',
      agreement: 'majority',
      providers: [{ url: 'https://eth.llamarpc.com/', value: null, agreed: true }],
    });
    // null values are filtered out (they produce no provider=value pair)
    // The function should not throw.
    let msg;
    assert.doesNotThrow(() => { msg = formatDisagreementWarning(entry, 'balance'); });
    // The warning may have empty pairs section
    assert.ok(typeof msg === 'string');
  });

  it('provider names are shortened (brand extraction) in the warning', () => {
    const entry = makeEntry({
      chain: 'ethereum',
      agreement: 'majority',
      providers: [
        { url: 'https://eth.llamarpc.com/', value: '1.0', agreed: true },
        { url: 'https://rpc.ankr.com/',     value: '1.1', agreed: false },
      ],
    });
    const msg = formatDisagreementWarning(entry, 'balance');
    // Provider names should be shortened: llamarpc and ankr (not full hostnames)
    assert.ok(msg.includes('llamarpc'), `expected "llamarpc" in: ${msg}`);
    assert.ok(msg.includes('ankr'),     `expected "ankr" in: ${msg}`);
    // Full hosts must not appear verbatim in the pairs
    assert.ok(!msg.includes('eth.llamarpc.com'), 'full hostname must not appear');
  });
});

// ---------------------------------------------------------------------------
// maybeEmitDisagreementWarnings
// ---------------------------------------------------------------------------

/**
 * Capture all writes to process.stderr during the execution of fn().
 * Restores the original write when done.
 *
 * @param {() => void} fn
 * @returns {string[]} lines written
 */
function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  try { fn(); } finally { process.stderr.write = original; }
  return chunks;
}

const ONE_DISAGREEMENT = [
  makeEntry({
    chain: 'ethereum',
    agreement: 'majority',
    providers: [
      { url: 'https://eth.llamarpc.com/', value: '1.0', agreed: true },
      { url: 'https://rpc.ankr.com/',     value: '1.1', agreed: false },
    ],
  }),
];

describe('maybeEmitDisagreementWarnings', () => {
  it('opts.json: true → emits nothing to stderr', () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const chunks = captureStderr(() =>
        maybeEmitDisagreementWarnings(ONE_DISAGREEMENT, 'balance', { json: true, ndjson: false }),
      );
      assert.equal(chunks.length, 0, 'must not write anything when json:true');
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('opts.ndjson: true → emits nothing to stderr', () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const chunks = captureStderr(() =>
        maybeEmitDisagreementWarnings(ONE_DISAGREEMENT, 'balance', { json: false, ndjson: true }),
      );
      assert.equal(chunks.length, 0, 'must not write anything when ndjson:true');
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('stderr.isTTY false → emits nothing', () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = false;
    try {
      const chunks = captureStderr(() =>
        maybeEmitDisagreementWarnings(ONE_DISAGREEMENT, 'balance', { json: false, ndjson: false }),
      );
      assert.equal(chunks.length, 0, 'must not write when not a TTY');
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('empty disagreements array → emits nothing', () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const chunks = captureStderr(() =>
        maybeEmitDisagreementWarnings([], 'balance', { json: false, ndjson: false }),
      );
      assert.equal(chunks.length, 0, 'must not write when disagreements is empty');
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('undefined disagreements → emits nothing', () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const chunks = captureStderr(() =>
        maybeEmitDisagreementWarnings(undefined, 'balance', { json: false, ndjson: false }),
      );
      assert.equal(chunks.length, 0, 'must not write when disagreements is undefined');
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('json:false ndjson:false TTY=true one disagreement → writes exactly ONE line', () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const chunks = captureStderr(() =>
        maybeEmitDisagreementWarnings(ONE_DISAGREEMENT, 'balance', { json: false, ndjson: false }),
      );
      assert.equal(chunks.length, 1, 'must write exactly one chunk for one disagreement');
      const line = chunks[0];
      assert.ok(line.endsWith('\n'), 'written line must be newline-terminated');
      assert.ok(line.includes('ethereum'), 'warning must mention the chain');
      assert.ok(line.includes('balance disagreement'), 'warning must include "balance disagreement"');
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('transaction flow with TTY=true one disagreement → line contains "transaction disagreement"', () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const txDisagreement = [
        makeEntry({
          chain: 'ethereum',
          agreement: 'majority',
          providers: [
            { url: 'https://eth.llamarpc.com/', value: '0xabc', agreed: true },
            { url: 'https://rpc.ankr.com/',     value: '0xdef', agreed: false },
          ],
        }),
      ];
      const chunks = captureStderr(() =>
        maybeEmitDisagreementWarnings(txDisagreement, 'transaction', { json: false, ndjson: false }),
      );
      assert.equal(chunks.length, 1);
      assert.ok(chunks[0].includes('transaction disagreement'));
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('two disagreements with TTY=true → writes two lines', () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const twoDisagreements = [
        makeEntry({ chain: 'ethereum', agreement: 'majority', providers: [
          { url: 'https://eth.llamarpc.com/', value: '1.0', agreed: true },
        ]}),
        makeEntry({ chain: 'polygon', agreement: 'majority', providers: [
          { url: 'https://polygon-bor-rpc.publicnode.com/', value: '5.0', agreed: true },
        ]}),
      ];
      const chunks = captureStderr(() =>
        maybeEmitDisagreementWarnings(twoDisagreements, 'balance', { json: false, ndjson: false }),
      );
      assert.equal(chunks.length, 2, 'must write one chunk per disagreement entry');
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });
});
