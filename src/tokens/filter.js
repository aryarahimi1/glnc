/**
 * src/tokens/filter.js
 *
 * Dust filter for token balances.
 *
 * Exports:
 *   filterDust(tokens, prices, opts?) => filteredTokens
 */

// Minimum USD value — balances with a known price below this are hidden.
const MIN_USD_VALUE = 1.0;

// Default cap on unpriced tokens shown per chain. Scam-airdrop tokens are
// almost always unpriced, and an unbounded list buries real holdings.
const DEFAULT_MAX_UNPRICED = 3;

/**
 * Remove dust balances from a list of already-fetched non-zero token balances.
 *
 * Rules:
 *   - amount === 0 is always removed (defensive guard)
 *   - If price is known and (amount * price) < MIN_USD_VALUE → removed
 *   - If price is NOT known → kept and marked noPrice:true, but capped to
 *     `maxUnpriced` (default 3) per call to keep scam airdrops from burying
 *     legitimate holdings. Pass `showUnpriced: true` to disable the cap.
 *
 * @param {{ symbol: string, amount: string, decimals: number, contract: string }[]} tokens
 * @param {{ [symbol: string]: number }} prices
 * @param {{ showUnpriced?: boolean, maxUnpriced?: number }} [opts]
 * @returns {{ symbol: string, amount: string, decimals: number, contract: string, noPrice?: true, unpricedHidden?: number }[]}
 */
export function filterDust(tokens, prices, opts = {}) {
  const showUnpriced = !!opts.showUnpriced;
  const maxUnpriced = Number.isFinite(opts.maxUnpriced)
    ? Math.max(0, opts.maxUnpriced)
    : DEFAULT_MAX_UNPRICED;

  // Normalise price keys to uppercase once for O(1) lookup.
  const upperPrices = {};
  for (const [sym, price] of Object.entries(prices ?? {})) {
    upperPrices[sym.toUpperCase()] = price;
  }

  const priced = [];
  const unpriced = [];

  for (const token of tokens) {
    const numericAmount = parseFloat(token.amount);
    if (numericAmount === 0) continue;

    const priceKey = token.symbol?.toUpperCase();
    const price = upperPrices[priceKey];

    if (price !== undefined && price !== null) {
      const usdValue = numericAmount * price;
      if (usdValue < MIN_USD_VALUE) continue;
      priced.push(token);
    } else {
      unpriced.push({ ...token, noPrice: true });
    }
  }

  if (showUnpriced || unpriced.length <= maxUnpriced) {
    return [...priced, ...unpriced];
  }

  // Truncate the unpriced list and annotate the last visible entry so the
  // renderer (or downstream JSON consumer) can surface the hidden count.
  const visible = unpriced.slice(0, maxUnpriced);
  const hidden = unpriced.length - visible.length;
  if (visible.length > 0 && hidden > 0) {
    visible[visible.length - 1] = { ...visible[visible.length - 1], unpricedHidden: hidden };
  }
  return [...priced, ...visible];
}
