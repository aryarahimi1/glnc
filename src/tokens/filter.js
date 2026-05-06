/**
 * src/tokens/filter.js
 *
 * Dust filter for token balances.
 *
 * Exports:
 *   filterDust(tokens, prices) => filteredTokens
 */

// Minimum USD value — balances with a known price below this are hidden.
const MIN_USD_VALUE = 1.0;

/**
 * Remove dust balances from a list of already-fetched non-zero token balances.
 *
 * Rules:
 *   - amount === 0 is always removed (defensive guard)
 *   - If price is known and (amount * price) < MIN_USD_VALUE → removed
 *   - If price is NOT known → KEPT, and a `noPrice: true` field is added
 *     so the renderer can show "—" instead of a USD value
 *
 * @param {{ symbol: string, amount: string, decimals: number, contract: string }[]} tokens
 *   Already-fetched balances (should be non-zero, but 0 is handled defensively).
 *
 * @param {{ [symbol: string]: number }} prices
 *   Symbol → USD price map from prices.js  (keys are UPPERCASE by convention,
 *   but we look up case-insensitively for safety).
 *
 * @returns {{ symbol: string, amount: string, decimals: number, contract: string, noPrice?: true }[]}
 */
export function filterDust(tokens, prices) {
  // Normalise price keys to uppercase once for O(1) lookup.
  const upperPrices = {};
  for (const [sym, price] of Object.entries(prices ?? {})) {
    upperPrices[sym.toUpperCase()] = price;
  }

  const result = [];

  for (const token of tokens) {
    // (b) Defensive: skip exact-zero amounts.
    const numericAmount = parseFloat(token.amount);
    if (numericAmount === 0) continue;

    const priceKey = token.symbol?.toUpperCase();
    const price = upperPrices[priceKey];

    if (price !== undefined && price !== null) {
      // (a) Price is known — apply the dust threshold.
      const usdValue = numericAmount * price;
      if (usdValue < MIN_USD_VALUE) continue;

      result.push(token);
    } else {
      // No price available — keep the token and mark it so the renderer
      // knows to show "—" rather than a USD figure.
      result.push({ ...token, noPrice: true });
    }
  }

  return result;
}
