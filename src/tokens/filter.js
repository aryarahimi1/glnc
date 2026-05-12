/**
 * src/tokens/filter.js
 *
 * Dust filter for token balances.
 *
 * Exports:
 *   filterDust(tokens, prices, opts?) => filteredTokens
 */

import { TOKEN_LISTS } from '../chains/_evm.js';

// Minimum USD value — balances with a known price below this are hidden.
const MIN_USD_VALUE = 1.0;

// Default cap on unpriced tokens shown per chain. Scam-airdrop tokens are
// almost always unpriced, and an unbounded list buries real holdings.
const DEFAULT_MAX_UNPRICED = 3;

// Per-chain set of canonical contract addresses (lowercased). Only tokens
// whose contract is in this set get a symbol-keyed price applied — this
// prevents scam ERC-20s spoofing names like "USDC" from inheriting the
// real token's price. To add new canonical tokens, extend TOKEN_LISTS in
// src/chains/_evm.js (the shared registry).
const CANONICAL_CONTRACTS_BY_CHAIN = new Map(
  Object.entries(TOKEN_LISTS).map(([chain, toks]) => [
    chain,
    new Set(toks.map(t => t.contract.toLowerCase())),
  ])
);

/**
 * Remove dust balances from a list of already-fetched non-zero token balances.
 *
 * Rules:
 *   - amount === 0 is always removed (defensive guard)
 *   - If price is known and (amount * price) < MIN_USD_VALUE → removed
 *   - If price is NOT known → kept and marked noPrice:true, but capped to
 *     `maxUnpriced` (default 3) per call to keep scam airdrops from burying
 *     legitimate holdings. Pass `showUnpriced: true` to disable the cap.
 *   - A symbol-keyed price is only applied when the token's contract is in
 *     the canonical allowlist for the given chain. Spoofed ERC-20s (e.g. a
 *     fake "USDC" at a non-canonical address) are treated as unpriced.
 *
 * @param {{ symbol: string, amount: string, decimals: number, contract: string }[]} tokens
 * @param {{ [symbol: string]: number }} prices
 * @param {{ showUnpriced?: boolean, maxUnpriced?: number, chain?: string }} [opts]
 * @returns {{ symbol: string, amount: string, decimals: number, contract: string, noPrice?: true, unpricedHidden?: number }[]}
 */
export function filterDust(tokens, prices, opts = {}) {
  const showUnpriced = !!opts.showUnpriced;
  const maxUnpriced = Number.isFinite(opts.maxUnpriced)
    ? Math.max(0, opts.maxUnpriced)
    : DEFAULT_MAX_UNPRICED;
  // A chain without an explicit canonical allowlist fails CLOSED — no
  // symbol-keyed prices are applied, so a spoofed ERC-20 cannot inherit the
  // real token's price on a chain whose list hasn't been verified yet.
  // If no chain is passed (legacy callers), preserve old behavior.
  const hasAllowlist = !!opts.chain;
  const canonicalSet = hasAllowlist
    ? CANONICAL_CONTRACTS_BY_CHAIN.get(opts.chain) ?? new Set()
    : null;

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
    const contractKey = token.contract?.toLowerCase();
    // canonicalSet === null   → legacy caller passed no chain; trust symbol
    // canonicalSet === Set    → chain has an allowlist; only contract matches qualify
    //   (an empty Set means "chain known but no canonicals verified yet" → fail closed)
    const isCanonical = canonicalSet === null
      ? true
      : (contractKey && canonicalSet.has(contractKey));
    const price = isCanonical ? upperPrices[priceKey] : undefined;

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
