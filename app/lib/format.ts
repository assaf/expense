/** Formatting helpers shared across server and client. */

import type { Expense } from "~/lib/types";

/** Format a decimal string ("12.3" / "12" / "12.34") as "$12.34". */
export function formatAmount(amount: string): string {
  const n = parseAmount(amount);
  if (n === null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/** Strictly parse a decimal string into a number, or null if invalid/empty. */
export function parseAmount(amount: string): number | null {
  const trimmed = amount.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}

/** Normalize a user-typed amount to two fractional digits. "" stays "". */
export function normalizeAmount(amount: string): string {
  const n = parseAmount(amount);
  if (n === null) return "";
  return n.toFixed(2);
}

/** Format a YYYY-MM-DD date as "Jan 2, 2026". Empty → "—". */
export function formatDate(date: string): string {
  if (!date) return "—";
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Today's date in the local timezone as YYYY-MM-DD. */
export function todayDate(): string {
  const now = new Date();
  const tzOffset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - tzOffset).toISOString().slice(0, 10);
}

/** Calendar year for a YYYY-MM-DD date, or the current year if empty. */
export function yearOf(date: string): string {
  if (date && /^\d{4}/.test(date)) return date.slice(0, 4);
  return String(new Date().getFullYear());
}

/** Build the mileage "merchant" label, e.g. "122.13 mi @ $0.70 / mi". */
export function mileageMerchant(distanceMiles: string, rate: string): string {
  const d = parseAmount(distanceMiles);
  const r = parseAmount(rate);
  if (d === null || r === null) return "";
  return `${d.toFixed(2)} mi @ $${r.toFixed(2)} / mi`;
}

/** The "merchant" label for an expense: the receipt merchant, or the mileage
 * label for mileage expenses. "" when there is nothing to show. */
export function merchantLabel(
  e: Expense,
  rates: Record<string, string>,
): string {
  if (e.type === "receipt") return e.merchant;
  return mileageMerchant(e.distanceMiles, rates[yearOf(e.date)] ?? "");
}

/**
 * Sort expenses by date; empty dates sort last (ties broken by createdAt).
 * `desc` (default) is newest-first — the home list and editor navigation;
 * pass `false` for chronological order (PDF/ZIP exports). Returns a new
 * array (callers' input is never mutated).
 */
export function sortExpenses(expenses: Expense[], desc = true): Expense[] {
  return [...expenses].sort((a, b) => {
    if (!a.date && !b.date) {
      return desc
        ? b.createdAt.localeCompare(a.createdAt)
        : a.createdAt.localeCompare(b.createdAt);
    }
    if (!a.date) return 1;
    if (!b.date) return -1;
    return desc ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
  });
}

/** "1 expense" / "3 expenses" — human count label. */
export function countLabel(count: number): string {
  return `${count} expense${count === 1 ? "" : "s"}`;
}

/**
 * Per-report expense counts + totals (amounts parsed, empty amounts don't
 * contribute). Expenses with no report are grouped under "Unassigned" only
 * when `includeUnassigned` is set; otherwise they are skipped — the export
 * page only lists real reports, the home page shows the Unassigned bucket.
 */
export function summarizeByReport(
  expenses: Expense[],
  opts: { includeUnassigned?: boolean } = {},
): Map<string, { count: number; total: number }> {
  const summary = new Map<string, { count: number; total: number }>();
  for (const e of expenses) {
    const name = e.report || (opts.includeUnassigned ? "Unassigned" : "");
    if (!name) continue;
    const s = summary.get(name) ?? { count: 0, total: 0 };
    s.count++;
    const amt = parseAmount(e.amount);
    if (amt !== null) s.total += amt;
    summary.set(name, s);
  }
  return summary;
}
