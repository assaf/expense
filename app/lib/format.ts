/** Formatting helpers shared across server and client. */

import Decimal from "decimal.js";

import type { Expense } from "~/lib/types";

/**
 * All money arithmetic goes through decimal.js (never IEEE float64). Amounts
 * are stored as decimal strings, parsed exactly, summed exactly, and rounded
 * exactly once at display time with ROUND_HALF_UP (`Decimal.toFixed`'s
 * default). The one float leak left is display-only: `formatAmount` feeds
 * `Intl.NumberFormat` a Number because its typings reject strings, but the
 * double error is far below half a cent for any real-world expense total,
 * so the displayed cent is always the exact one.
 */

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Format a decimal string ("12.3" / "12" / "12.34") as "$12.34". */
export function formatAmount(amount: string | Decimal): string {
  const d = typeof amount === "string" ? parseAmount(amount) : amount;
  if (d === null) return "—";
  return usd.format(d.toNumber());
}

/**
 * Strictly parse a decimal string into an exact Decimal, or null if
 * invalid/empty. Never returns an IEEE float — arithmetic on the result is
 * exact (see `summarizeByReport`).
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

/**
 * Normalize a user-typed amount to two fractional digits (ROUND_HALF_UP —
 * `Decimal.toFixed`'s default). "" stays "". Unlike Number.prototype.toFixed
 * this rounds exact decimal halves correctly: "1.005" → "1.01".
 */
export function normalizeAmount(amount: string): string {
  const d = parseAmount(amount);
  if (d === null) return "";
  return d.toFixed(2);
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
 * Per-report expense counts + exact totals. Amounts are parsed as Decimals
 * and accumulated with exact decimal addition — no float drift, so a report
 * total is the exact sum of its line items.
 */
export function summarizeByReport(
  expenses: Expense[],
  opts: { includeUnassigned?: boolean } = {},
): Map<string, { count: number; total: Decimal }> {
  const summary = new Map<string, { count: number; total: Decimal }>();
  for (const e of expenses) {
    const name = e.report || (opts.includeUnassigned ? "Unassigned" : "");
    if (!name) continue;
    const s = summary.get(name) ?? { count: 0, total: new Decimal(0) };
    s.count++;
    const amt = parseAmount(e.amount);
    if (amt !== null) s.total = s.total.add(amt);
    summary.set(name, s);
  }
  return summary;
}
