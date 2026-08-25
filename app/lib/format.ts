/** Formatting helpers shared across server and client. */

import Decimal from "decimal.js";

import { parseAmount } from "~/lib/money";
import {
  MILEAGE_TYPE_LABELS,
  formatRate,
  mileageRateFor,
  type MileageRateEntry,
} from "~/lib/mileage-rates";
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
 * Normalize a user-typed amount to two fractional digits (ROUND_HALF_UP,
 * `Decimal.toFixed`'s default). "" stays "". Unlike Number.prototype.toFixed
 * this rounds exact decimal halves correctly: "1.005" → "1.01".
 */
export function normalizeAmount(amount: string): string {
  const d = parseAmount(amount);
  if (d === null) return "";
  return d.toFixed(2);
}

/** Format a YYYY-MM-DD date as "Jan 2, 2026", or "August 12, 2026" when
 * `long` is set. Empty → "—". */
export function formatDate(
  date: string,
  opts: { long?: boolean } = {},
): string {
  if (!date) return "—";
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: opts.long ? "long" : "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Short "Aug 4, 2026" label for an ISO timestamp; "—" when unset. */
export function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
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

/** Build the mileage label, e.g. "32.00 mi @ $0.70 / mi". Without a rate
 * (no IRS period covers the trip's date/type) the distance still shows:
 * "32.00 mi". Half-cent rates keep their third decimal ("$0.235 / mi"). */
export function mileageMerchant(distanceMiles: string, rate: string): string {
  const d = parseAmount(distanceMiles);
  if (d === null) return "";
  const r = parseAmount(rate);
  const distance = `${d.toFixed(2)} mi`;
  return r === null ? distance : `${distance} @ $${formatRate(rate)} / mi`;
}

/** Mileage distance shown as "(9.45 miles)". "" when unset/unparseable. */
export function mileageDistanceLabel(distanceMiles: string): string {
  const d = parseAmount(distanceMiles);
  return d === null ? "" : `(${d.toFixed(2)} miles)`;
}

/** The "merchant" label for an expense: the receipt merchant, or the mileage
 * label for mileage expenses. The mileage rate is resolved from the IRS
 * master table by the trip's date + type. "" when there is nothing to show. */
export function merchantLabel(e: Expense, rates: MileageRateEntry[]): string {
  if (e.type === "receipt") return e.merchant;
  const label = MILEAGE_TYPE_LABELS[e.mileageType];
  const distance = mileageMerchant(
    e.distanceMiles,
    mileageRateFor(rates, e.date, e.mileageType),
  );
  return distance ? `${label} · ${distance}` : label;
}

/**
 * Sort expenses by date; empty dates sort last (ties broken by createdAt).
 * `desc` (default) is newest-first (the home list and editor navigation);
 * pass `false` for chronological order (PDF/ZIP exports). Returns a new
 * array (callers' input is never mutated).
 */
export function sortExpenses(expenses: Expense[], desc = true): Expense[] {
  return expenses.toSorted((a, b) => {
    if (!a.date && !b.date) {
      return desc
        ? b.createdAt.localeCompare(a.createdAt)
        : a.createdAt.localeCompare(b.createdAt);
    }
    if (!a.date) return 1;
    if (!b.date) return -1;
    // Same day → by when the expense was recorded (imported receipts:
    // arrival order; manual entries: entry order). The date itself is
    // day-granular, so createdAt is the only time signal available.
    return desc
      ? b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)
      : a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt);
  });
}

/** "1 expense" / "3 expenses": human count label. */
export function countLabel(count: number): string {
  return `${count} expense${count === 1 ? "" : "s"}`;
}

/**
 * Per-group expense counts + exact totals, grouped by the key `keyOf`
 * returns (empty keys are skipped). Amounts are parsed as Decimals and
 * accumulated with exact decimal addition (no float drift), so a total is
 * the exact sum of its line items. Shared by the report summary (web +
 * MCP `list_reports`) and the MCP `expense_summary` category breakdown.
 */
export function summarizeBy(
  expenses: Expense[],
  keyOf: (e: Expense) => string,
): Map<string, { count: number; total: Decimal }> {
  const summary = new Map<string, { count: number; total: Decimal }>();
  for (const e of expenses) {
    const key = keyOf(e);
    if (!key) continue;
    const s = summary.get(key) ?? { count: 0, total: new Decimal(0) };
    s.count++;
    const amt = parseAmount(e.amount);
    if (amt !== null) s.total = s.total.add(amt);
    summary.set(key, s);
  }
  return summary;
}

/** Per-report expense counts + exact totals, "Unassigned" bucket opt-in. */
export function summarizeByReport(
  expenses: Expense[],
  opts: { includeUnassigned?: boolean } = {},
): Map<string, { count: number; total: Decimal }> {
  return summarizeBy(
    expenses,
    (e) => e.report || (opts.includeUnassigned ? "Unassigned" : ""),
  );
}
