import type { Expense } from "~/lib/types";
import { parseAmount } from "~/lib/format";

/** A non-zero monetary amount is required for completeness (0 / empty = incomplete). */
function hasAmount(amount: string): boolean {
  const n = parseAmount(amount);
  return n !== null && n !== 0;
}

/** A receipt is complete when it has date, merchant, amount, image, category, report. */
export function isReceiptComplete(
  e: Extract<Expense, { type: "receipt" }>,
): boolean {
  return Boolean(
    e.date &&
    e.merchant.trim() &&
    e.imageFile &&
    e.category.trim() &&
    e.report.trim() &&
    hasAmount(e.amount),
  );
}

/** A mileage expense is complete with date, amount, 2+ addresses, and a report. */
export function isMileageComplete(
  e: Extract<Expense, { type: "mileage" }>,
): boolean {
  return Boolean(
    e.date &&
    e.report.trim() &&
    hasAmount(e.amount) &&
    e.locations.filter((l) => l.address.trim()).length >= 2,
  );
}

export function isComplete(e: Expense): boolean {
  return e.type === "receipt" ? isReceiptComplete(e) : isMileageComplete(e);
}
