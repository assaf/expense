import { formatAmount, formatDate } from "~/lib/format";
import { parseAmount } from "~/lib/money";
import type { Expense, MileageExpense, ReceiptExpense } from "~/lib/types";

/**
 * Duplicate detection for the expense list and the create editor.
 *
 * Two expenses are duplicates when they describe the same entry:
 *  - receipts: same date + same merchant + same amount to the cent, and the
 *    category, report, and description agree: each field matches when both
 *    are empty or when the values are the same. A difference in any of the
 *    three (e.g. one categorized, one not; different receipt numbers in the
 *    description) means the entries are not duplicates.
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
 * fetch; no extra queries, no stored state. The only persisted thing is
 * the dismissal of a pair the user has marked "not a duplicate", one row
 * in the `duplicate_dismissals` table per pair (read as a `Set` of
 * `duplicatePairKey` strings by `readDuplicateDismissals`).
 */

/** Why two expenses look like the same entry. */
export type DuplicateReason =
  | "same-image"
  | "same-date-merchant-amount"
  | "same-route";

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

export function groupDuplicateMatches(
  expenses: readonly Expense[],
  dismissed: ReadonlySet<string> = new Set(),
): Map<string, DuplicateMatch[]> {
  const byKey = new Map<
    string,
    { reason: DuplicateReason; expenses: Expense[] }
  >();
  for (const e of expenses) {
    for (const keyed of matchKeys(e)) {
      const bucket = byKey.get(keyed.key) ?? {
        reason: keyed.reason,
        expenses: [],
      };
      bucket.expenses.push(e);
      byKey.set(keyed.key, bucket);
    }
  }

  const matches = new Map<string, DuplicateMatch[]>();
  // Directional: a pair reports a→b AND b→a; two buckets sharing the pair
  // (same image AND same fields) report it once per direction, from the
  // strongest reason. matchKeys orders the image key first and each
  // expense registers its image key before its content key, so the image
  // bucket is always met first.
  const reported = new Set<string>();
  for (const bucket of byKey.values()) {
    if (bucket.expenses.length < 2) continue;
    for (const e of bucket.expenses) {
      for (const other of bucket.expenses) {
        if (other.id === e.id) continue;
        if (dismissed.has(duplicatePairKey(e.id, other.id))) continue;
        const direction = `${e.id}>${other.id}`;
        if (reported.has(direction)) continue;
        reported.add(direction);
        const list = matches.get(e.id) ?? [];
        list.push({ expense: other, reason: bucket.reason });
        matches.set(e.id, list);
      }
    }
  }
  // Oldest match first, so the warning points at the original entry.
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
 * Every key the expense matches duplicates on, strongest first. A receipt
 * can carry two: the image fingerprint (the same bytes, whatever the
 * fields say) and the content key (date + merchant + amount + the rest).
 * Mileage has one (date + ordered route + distance).
 */
function matchKeys(
  e: Expense,
): Array<{ key: string; reason: DuplicateReason }> {
  if (e.type === "mileage") {
    const keyed = mileageKey(e);
    return keyed ? [keyed] : [];
  }
  const keys: Array<{ key: string; reason: DuplicateReason }> = [];
  if (e.imageSha256) {
    keys.push({ key: `image|${e.imageSha256}`, reason: "same-image" });
  }
  const content = receiptKey(e);
  if (content) keys.push(content);
  return keys;
}

function receiptKey(
  e: ReceiptExpense,
): { key: string; reason: DuplicateReason } | null {
  if (!e.date) return null;
  const merchant = normalizeMerchant(e.merchant);
  if (!merchant) return null;
  const amount = parseAmount(e.amount);
  if (amount === null) return null;
  // Category/report/description are equal-unless-different: both empty or
  // the same value matches, any difference splits the pair. Category and
  // report compare normalized (case/whitespace-insensitive, like the
  // merchant); description compares exactly after trimming (receipt
  // numbers and account names are case-sensitive data.
  const category = normalizeMerchant(e.category);
  const report = normalizeMerchant(e.report);
  const description = e.description.trim();
  return {
    key: `receipt|${e.date}|${merchant}|${amount.toString()}|${category}|${report}|${description}`,
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
