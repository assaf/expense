import Decimal from "decimal.js";

/**
 * Strictly parse a decimal string into an exact Decimal, or null if
 * invalid/empty, or beyond money scale: e-notation with a huge positive
 * exponent would expand to a heap-killing string in toFixed, so the bound
 * lives here rather than at each entry point. Never returns an IEEE float;
 * arithmetic on the result is exact (see `summarizeBy`). Shared by the
 * money math in format.ts (sums, display) and mileage-rates.ts
 * (distance × rate).
 */
export function parseAmount(amount: string): Decimal | null {
  const trimmed = amount.trim();
  if (trimmed === "") return null;
  let parsed: Decimal;
  try {
    parsed = new Decimal(trimmed);
  } catch {
    return null;
  }
  if (parsed.e > 15) return null;
  return parsed;
}

/** The largest value the money columns hold: `numeric(10,2)` has eight
 * integer digits, so 10^8 and up makes Postgres raise `numeric field
 * overflow` (a 500) instead of the app refusing what it cannot store. */
const MAX_MONEY = new Decimal("99999999.99");

/** True when an amount is a number the money columns cannot hold. Junk and
 * empty parse to null and are not "too large": the caller's own
 * "needs an amount" handling covers those. */
export function exceedsMaxMoney(amount: string): boolean {
  const parsed = parseAmount(amount);
  return parsed !== null && parsed.abs().gt(MAX_MONEY);
}
