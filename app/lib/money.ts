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
