import type { Expense } from "~/lib/types";
import { parseAmount } from "~/lib/money";

/** A non-zero monetary amount is required for completeness (0 / empty = incomplete). */
export function hasAmount(amount: string): boolean {
  const d = parseAmount(amount);
  return d !== null && !d.isZero();
}

/** A receipt is complete when it has date, merchant, amount, category, and
 * report. The receipt image is deliberately NOT a completeness factor; the
 * badge tracks the data fields only. */
export function isReceiptComplete(
  e: Extract<Expense, { type: "receipt" }>,
): boolean {
  return Boolean(
    e.date &&
    e.merchant.trim() &&
    e.category.trim() &&
    e.report.trim() &&
    hasAmount(e.amount),
  );
}

/** A mileage expense is complete with date, amount, category, report, and at
 * least two route addresses (the route is what the distance and amount are
 * calculated from). Mileage has no merchant field. */
export function isMileageComplete(
  e: Extract<Expense, { type: "mileage" }>,
): boolean {
  return Boolean(
    e.date &&
    e.category.trim() &&
    e.report.trim() &&
    hasAmount(e.amount) &&
    hasEnoughStops(e.locations),
  );
}

/** A trip needs at least two non-empty stop addresses (shared by the
 * completeness check and MCP logMileage validation). */
export function hasEnoughStops(locations: Array<{ address: string }>): boolean {
  return locations.filter((l) => l.address.trim()).length >= 2;
}

export function isComplete(e: Expense): boolean {
  return e.type === "receipt" ? isReceiptComplete(e) : isMileageComplete(e);
}
