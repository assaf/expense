import Decimal from "decimal.js";

/**
 * Strictly parse a decimal string into an exact Decimal, or null if
 * invalid/empty. Never returns an IEEE float — arithmetic on the result is
 * exact (see `summarizeBy`). Shared by the money math in format.ts (sums,
 * display) and mileage-rates.ts (distance × rate).
 */
export function parseAmount(amount: string): Decimal | null {
  const trimmed = amount.trim();
  if (trimmed === "") return null;
  try {
    return new Decimal(trimmed);
  } catch {
    return null;
  }
}
