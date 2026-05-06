/**
 * src/alert/conditions.js
 *
 * Parser and evaluator for the alert condition DSL.
 * Syntax: <lhs> <op> <number>
 *
 * Supported LHS paths (case-insensitive):
 *   balance.<symbol>          — token amount in human units
 *   balance.<symbol>.usd      — token amount × USD price
 *   aave.healthfactor / aave.hf
 *   aave.collateralusd
 *   aave.debtusd
 *   aave.netusd
 */

const VALID_OPS = new Set(['<', '<=', '>', '>=', '==', '!=']);

/**
 * @typedef {{ lhs: string[], op: string, rhs: number }} ParsedCondition
 */

/**
 * Parse a condition string into its components.
 * Throws with a descriptive message on invalid input.
 *
 * @param {string} str
 * @returns {ParsedCondition}
 */
export function parseCondition(str) {
  const parts = str.trim().split(/\s+/);
  if (parts.length !== 3) {
    throw new Error(
      `Unsupported condition: "${str}". ` +
      `Expected exactly 3 tokens: <lhs> <op> <number>. Got ${parts.length}.`
    );
  }

  const [lhsRaw, op, rhsRaw] = parts;

  if (!VALID_OPS.has(op)) {
    throw new Error(
      `Unsupported operator: "${op}". Valid operators: ${[...VALID_OPS].join(', ')}`
    );
  }

  const rhs = Number(rhsRaw);
  if (isNaN(rhs)) {
    throw new Error(
      `Right-hand side "${rhsRaw}" is not a valid number.`
    );
  }

  const lhs = lhsRaw.toLowerCase().split('.');

  // Validate lhs path prefix
  if (lhs[0] !== 'balance' && lhs[0] !== 'aave') {
    throw new Error(
      `Unsupported condition path: "${lhsRaw}". ` +
      `Path must start with "balance" or "aave".`
    );
  }

  if (lhs[0] === 'balance' && lhs.length < 2) {
    throw new Error(
      `balance path requires a symbol, e.g. "balance.eth" or "balance.eth.usd".`
    );
  }

  if (lhs[0] === 'aave') {
    const field = lhs[1];
    const validAaveFields = ['healthfactor', 'hf', 'collateralusd', 'debtusd', 'netusd'];
    if (!validAaveFields.includes(field)) {
      throw new Error(
        `Unsupported aave field: "${field}". ` +
        `Valid fields: ${validAaveFields.join(', ')}`
      );
    }
  }

  return { lhs, op, rhs };
}

/**
 * @typedef {{
 *   balanceResult?: { native: { symbol: string, amount: string|number }, tokens: Array<{ symbol: string, amount: string|number }>, error?: string },
 *   aaveResult?: import('../positions/aave.js').AaveResult,
 *   prices?: Record<string, number>,
 * }} ContextInput
 */

/**
 * Build the evaluation context from chain data.
 *
 * @param {ContextInput} input
 * @returns {object}
 */
export function buildContext({ balanceResult, aaveResult, prices = {} }) {
  const ctx = { balance: {}, aave: null };

  // Populate balance paths from chain adapter result
  if (balanceResult && !balanceResult.error) {
    const addAsset = (symbol, amount) => {
      const sym = symbol.toLowerCase();
      const amt = parseFloat(String(amount));
      if (isNaN(amt)) return;

      if (!ctx.balance[sym]) ctx.balance[sym] = {};
      ctx.balance[sym]._amount = amt;

      const price = prices[symbol.toUpperCase()];
      if (price !== undefined) {
        ctx.balance[sym].usd = amt * price;
      }
    };

    if (balanceResult.native?.symbol != null && balanceResult.native?.amount != null) {
      addAsset(balanceResult.native.symbol, balanceResult.native.amount);
    }
    for (const token of balanceResult.tokens ?? []) {
      if (token.symbol != null && token.amount != null) {
        addAsset(token.symbol, token.amount);
      }
    }
  }

  // Populate aave paths
  if (aaveResult?.hasPosition) {
    const hfStr = aaveResult.healthFactor;
    const hfNum = hfStr === '∞' ? Infinity : parseFloat(hfStr);

    ctx.aave = {
      healthfactor: isNaN(hfNum) ? null : hfNum,
      hf:           isNaN(hfNum) ? null : hfNum,
      collateralusd: aaveResult.collateralUsd != null ? parseFloat(aaveResult.collateralUsd) : null,
      debtusd:       aaveResult.debtUsd       != null ? parseFloat(aaveResult.debtUsd)       : null,
      netusd:        aaveResult.netUsd         != null ? parseFloat(aaveResult.netUsd)         : null,
    };
  }

  return ctx;
}

/**
 * Resolve the LHS path in the context and return its numeric value, or null.
 *
 * @param {string[]} lhs
 * @param {object} ctx
 * @returns {number|null}
 */
function resolveLhs(lhs, ctx) {
  if (lhs[0] === 'balance') {
    const sym = lhs[1];
    const assetCtx = ctx.balance[sym];
    if (!assetCtx) return null;

    // balance.<symbol>.usd
    if (lhs[2] === 'usd') {
      return assetCtx.usd ?? null;
    }

    // balance.<symbol>
    return assetCtx._amount ?? null;
  }

  if (lhs[0] === 'aave') {
    if (!ctx.aave) return null;
    const field = lhs[1]; // already lowercased by parseCondition
    return ctx.aave[field] ?? null;
  }

  return null;
}

/**
 * Evaluate a parsed condition against a context.
 *
 * @param {ParsedCondition} parsed
 * @param {object} ctx  — from buildContext
 * @returns {{ ok: boolean, lhsValue: number|null, reason: string }}
 */
export function evaluateCondition(parsed, ctx) {
  const { lhs, op, rhs } = parsed;
  const lhsValue = resolveLhs(lhs, ctx);

  if (lhsValue === null) {
    return {
      ok: false,
      lhsValue: null,
      reason: `LHS path "${lhs.join('.')}" resolved to null (missing data or no position)`,
    };
  }

  let ok;
  switch (op) {
    case '<':  ok = lhsValue <  rhs; break;
    case '<=': ok = lhsValue <= rhs; break;
    case '>':  ok = lhsValue >  rhs; break;
    case '>=': ok = lhsValue >= rhs; break;
    case '==': ok = lhsValue === rhs; break;
    case '!=': ok = lhsValue !== rhs; break;
    default:   ok = false;
  }

  return {
    ok,
    lhsValue,
    reason: `${lhsValue} ${op} ${rhs} → ${ok}`,
  };
}
