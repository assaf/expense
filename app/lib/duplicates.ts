import { formatAmount, formatDate, parseAmount } from "~/lib/format";
import type { Expense, MileageExpense, ReceiptExpense } from "~/lib/types";

/**
 * Duplicate detection for the expense list and the create editor.
 *
 * Two expenses are duplicates when they describe the same entry:
 *  - receipts: same date + same merchant + same amount to the cent
 *  - mileage:  same date + same ordered route + same distance
 *
 * The same-date requirement is what keeps recurring charges (a monthly
 * subscription) and repeated identical purchases (a $40 gas fill-up in two
 * different weeks) from false-positiving. Amounts are compared exactly as
 * Decimals with the sign included, so a refund (-$5) never matches a charge
 * (+$5). Entries too incomplete to compare (missing date, merchant, amount,
 * route, or distance) can't match anything.
 *
 * Matching is a pure function over the expense rows the loaders already
 * fetch — no extra queries, no stored state. The only persisted thing is the
 * dismissal of a pair the user has marked "not a duplicate"
 * (settings.duplicateDismissals, `duplicatePairKey` strings).
 */

/** Why two expenses look like the same entry. */
export type DuplicateReason = "same-date-merchant-amount" | "same-route";

/** One existing expense that looks like the same entry as another. */
export interface DuplicateMatch {
  expense: Expense;
  reason: DuplicateReason;
}

/** Stable pair key (`minId|maxId`) so a dismissal matches either direction. */
export function duplicatePairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

/**
 * Expenses in `others` that look like the same entry as `candidate`. Never
 * matches the candidate to itself, and skips pairs the user has dismissed.
 * Oldest match first, so a warning can point at the original entry.
 */
export function findDuplicates(
  candidate: Expense,
  others: readonly Expense[],
  dismissed: ReadonlySet<string> = new Set(),
): DuplicateMatch[] {
  return (
    groupDuplicateMatches([candidate, ...others], dismissed).get(
      candidate.id,
    ) ?? []
  );
}

/**
 * One pass over every expense: which others each one looks like. Used by the
 * home list loader to badge duplicate rows on both sides of a pair; the
 * create editor's `findDuplicates` is the same grouping for one candidate.
 */
export function groupDuplicateMatches(
  expenses: readonly Expense[],
  dismissed: ReadonlySet<string> = new Set(),
): Map<string, DuplicateMatch[]> {
  const byKey = new Map<
    string,
    { reason: DuplicateReason; expenses: Expense[] }
  >();
  for (const e of expenses) {
    const keyed = matchKey(e);
    if (!keyed) continue;
    const bucket = byKey.get(keyed.key) ?? {
      reason: keyed.reason,
      expenses: [],
    };
    bucket.expenses.push(e);
    byKey.set(keyed.key, bucket);
  }

  const matches = new Map<string, DuplicateMatch[]>();
  for (const bucket of byKey.values()) {
    if (bucket.expenses.length < 2) continue;
    for (const e of bucket.expenses) {
      for (const other of bucket.expenses) {
        if (other.id === e.id) continue;
        if (dismissed.has(duplicatePairKey(e.id, other.id))) continue;
        const list = matches.get(e.id) ?? [];
        list.push({ expense: other, reason: bucket.reason });
        matches.set(e.id, list);
      }
    }
  }
  // Oldest match first — the warning points at the original entry.
  for (const list of matches.values()) {
    list.sort((a, b) => a.expense.createdAt.localeCompare(b.expense.createdAt));
  }
  return matches;
}

/** Human-readable description of a matching expense, e.g.
 * "Blue Bottle Coffee, Jun 3, 2026, $6.50" or "a 32.00 mi trip on Mar 10". */
export function duplicateLabel(e: Expense): string {
  if (e.type === "receipt") {
    return `${e.merchant}, ${formatDate(e.date)}, ${formatAmount(e.amount)}`;
  }
  return `a ${e.distanceMiles} mi trip on ${formatDate(e.date)}`;
}

/**
 * The normalized key two expenses share exactly when they are duplicates.
 * Null when the entry is too incomplete to compare.
 */
function matchKey(e: Expense): { key: string; reason: DuplicateReason } | null {
  return e.type === "receipt" ? receiptKey(e) : mileageKey(e);
}

function receiptKey(
  e: ReceiptExpense,
): { key: string; reason: DuplicateReason } | null {
  if (!e.date) return null;
  const merchant = normalizeMerchant(e.merchant);
  if (!merchant) return null;
  const amount = parseAmount(e.amount);
  if (amount === null) return null;
  return {
    key: `receipt|${e.date}|${merchant}|${amount.toString()}`,
    reason: "same-date-merchant-amount",
  };
}

function mileageKey(
  e: MileageExpense,
): { key: string; reason: DuplicateReason } | null {
  if (!e.date) return null;
  const distance = parseAmount(e.distanceMiles);
  if (distance === null) return null;
  // Routes compare as the ordered list of non-empty addresses: A → B is a
  // different trip than B → A, so order matters.
  const addresses = e.locations.map((l) => l.address.trim()).filter(Boolean);
  if (addresses.length < 2) return null;
  return {
    key: `mileage|${e.date}|${JSON.stringify(addresses)}|${distance.toString()}`,
    reason: "same-route",
  };
}

/** Case- and whitespace-insensitive merchant comparison. */
export function normalizeMerchant(merchant: string): string {
  return merchant.trim().replace(/\s+/g, " ").toLowerCase();
}
