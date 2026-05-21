/**
 * test/csv.test.js
 *
 * Formula-injection guard tests for src/history/csv.js
 * Uses node:test + node:assert/strict — no external deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rowsToCsv, CSV_COLUMNS } from '../src/history/csv.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal row where only tokenIn is set, parse the resulting
// CSV and return the token_in cell value (still quoted/escaped, raw CSV text).
// ---------------------------------------------------------------------------
function tokenInCell(value) {
  const csv = rowsToCsv([{ tokenIn: value }]);
  // Header is first line; data row is second line.
  const dataLine = csv.split('\r\n')[1];
  // token_in is column index 5 (0-based) in CSV_COLUMNS.
  const idx = CSV_COLUMNS.indexOf('token_in');
  // Split respecting quoted fields via a simple RFC-4180 parser.
  return parseFirstRow(dataLine)[idx];
}

/** Minimal RFC-4180 field splitter (handles double-quote escaping). */
function parseFirstRow(line) {
  const fields = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      // Quoted field — read until closing unescaped quote.
      let field = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      // Unquoted field — read until comma or end.
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Helper: assert that a raw CSV cell (as it appears verbatim in the file,
// including surrounding quotes) starts and ends as expected.
// ---------------------------------------------------------------------------
function rawCell(value) {
  const csv = rowsToCsv([{ tokenIn: value }]);
  const dataLine = csv.split('\r\n')[1];
  const idx = CSV_COLUMNS.indexOf('token_in');
  // We need the RAW text, not the parsed value, so do a naive comma-aware
  // split that keeps quote boundaries intact.
  return rawFields(dataLine)[idx];
}

/** Split a CSV line into raw field tokens (including surrounding quotes). */
function rawFields(line) {
  const fields = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let field = '"';
      i++;
      while (i < line.length) {
        field += line[i];
        if (line[i] === '"' && line[i + 1] !== '"') {
          i++;
          break;
        }
        if (line[i] === '"' && line[i + 1] === '"') {
          field += line[i + 1];
          i += 2;
          continue;
        }
        i++;
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// 1. Leading-character variants that trigger formula guard
// ---------------------------------------------------------------------------

describe('formula injection guard — leading trigger characters', () => {
  const cases = [
    ['=cmd',           '=',  'equals'],
    ['+cmd',           '+',  'plus'],
    ['-cmd',           '-',  'minus'],
    ['@cmd',           '@',  'at'],
    ['\tcmd',          '\t', 'tab'],
    ['\rcmd',          '\r', 'carriage-return'],
  ];

  for (const [input, , label] of cases) {
    it(`prefixes with single-quote and wraps in double-quotes: ${label}`, () => {
      const raw = rawCell(input);
      // Must be a quoted field starting with "'
      assert.ok(raw.startsWith('"\''), `expected raw cell to start with "' but got: ${raw}`);
      assert.ok(raw.endsWith('"'),    `expected raw cell to end with " but got: ${raw}`);
    });

    it(`parsed value starts with single-quote: ${label}`, () => {
      const parsed = tokenInCell(input);
      assert.ok(parsed.startsWith("'"), `expected parsed value to start with ' but got: ${parsed}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Cells with quote/comma/CR/LF but no formula trigger — old escaping works
// ---------------------------------------------------------------------------

describe('legacy quoting — no formula trigger', () => {
  it('wraps cell containing comma in double-quotes', () => {
    const raw = rawCell('hello, world');
    assert.equal(raw, '"hello, world"');
  });

  it('doubles embedded double-quotes', () => {
    const raw = rawCell('say "hi"');
    assert.equal(raw, '"say ""hi"""');
  });

  it('wraps cell containing newline', () => {
    const raw = rawCell('line1\nline2');
    assert.equal(raw, '"line1\nline2"');
  });

  it('wraps cell containing CR', () => {
    // \r alone (not a leading char) — no formula guard needed, just quote-wrap
    const raw = rawCell('a\rb');
    assert.equal(raw, '"a\rb"');
  });
});

// ---------------------------------------------------------------------------
// 3. Cells with both: leading formula trigger AND embedded comma
// ---------------------------------------------------------------------------

describe('formula guard + embedded comma', () => {
  it('prefixes with single-quote and preserves comma quoting', () => {
    const input = '=SUM(A1,B1)';
    const raw = rawCell(input);
    // Should start with "'= and end with "
    assert.ok(raw.startsWith('"\'='), `raw: ${raw}`);
    assert.ok(raw.endsWith('"'),      `raw: ${raw}`);
    // Parsed value should start with ' and contain the original string
    const parsed = tokenInCell(input);
    assert.equal(parsed, "'" + input);
  });
});

// ---------------------------------------------------------------------------
// 4. Plain alphanumeric strings — unchanged, no quoting
// ---------------------------------------------------------------------------

describe('plain alphanumeric strings — no modification', () => {
  it('leaves plain symbol unchanged', () => {
    assert.equal(tokenInCell('USDC'), 'USDC');
    assert.equal(rawCell('USDC'), 'USDC');
  });

  it('leaves numeric-looking string without leading trigger unchanged', () => {
    assert.equal(tokenInCell('1234'), '1234');
    assert.equal(rawCell('1234'), '1234');
  });

  it('leaves empty string unchanged', () => {
    assert.equal(tokenInCell(''), '');
    assert.equal(rawCell(''), '');
  });
});

// ---------------------------------------------------------------------------
// 5. Realistic HYPERLINK attack payload through rowsToCsv()
// ---------------------------------------------------------------------------

describe('realistic HYPERLINK attack payload', () => {
  it('escapes HYPERLINK formula so spreadsheet cannot evaluate it', () => {
    const payload = '=HYPERLINK("http://evil/", "click")';
    const csv = rowsToCsv([{ tokenIn: payload }]);
    const dataLine = csv.split('\r\n')[1];
    const raw = rawFields(dataLine)[CSV_COLUMNS.indexOf('token_in')];
    // Raw cell must start with "'= (formula neutralised)
    assert.ok(raw.startsWith('"\'='), `raw cell: ${raw}`);
    // Must be a closed quoted field
    assert.ok(raw.endsWith('"'), `raw cell: ${raw}`);
    // The parsed/decoded value must start with a literal single-quote
    const parsed = tokenInCell(payload);
    assert.ok(parsed.startsWith("'="), `parsed: ${parsed}`);
  });
});

// ---------------------------------------------------------------------------
// 6. Non-string types: numbers, bigints, booleans, null, undefined
// ---------------------------------------------------------------------------

describe('non-string types — no formula guard applied', () => {
  function cellForType(rowPatch) {
    const csv = rowsToCsv([rowPatch]);
    const dataLine = csv.split('\r\n')[1];
    const idx = CSV_COLUMNS.indexOf('token_in');
    return rawFields(dataLine)[idx];
  }

  it('finite number emits numeric string without quoting', () => {
    assert.equal(cellForType({ tokenIn: 42 }), '42');
  });

  it('non-finite number emits empty string', () => {
    assert.equal(cellForType({ tokenIn: Infinity }), '');
  });

  it('bigint emits string representation without quoting', () => {
    assert.equal(cellForType({ tokenIn: 9007199254740993n }), '9007199254740993');
  });

  it('boolean true emits "true"', () => {
    assert.equal(cellForType({ tokenIn: true }), 'true');
  });

  it('boolean false emits "false"', () => {
    assert.equal(cellForType({ tokenIn: false }), 'false');
  });

  it('null emits empty string', () => {
    assert.equal(cellForType({ tokenIn: null }), '');
  });

  it('undefined emits empty string', () => {
    assert.equal(cellForType({ tokenIn: undefined }), '');
  });
});

// ---------------------------------------------------------------------------
// 7. Cell whose value already starts with a literal single-quote
// ---------------------------------------------------------------------------

describe("cell already starting with single-quote (e.g. token name \"'WRAP\")", () => {
  it("does NOT trigger formula guard — single-quote is not a trigger char", () => {
    const raw = rawCell("'WRAP");
    // ' is not in the trigger set [=+-@\t\r], so no additional prefix.
    // It also has no comma/CR/LF/quote, so it should be emitted as-is.
    assert.equal(raw, "'WRAP");
  });

  it('parsed value round-trips correctly', () => {
    assert.equal(tokenInCell("'WRAP"), "'WRAP");
  });

  it("token name starting with ' AND containing a comma still gets quoted but no double-prefix", () => {
    const input = "'WRAP, v2";
    const raw = rawCell(input);
    // Contains a comma → must be quoted, but single-quote is not a formula trigger
    assert.equal(raw, "\"'WRAP, v2\"");
    const parsed = tokenInCell(input);
    assert.equal(parsed, "'WRAP, v2");
  });
});
