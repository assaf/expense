import {
  matchesSearch,
  parseQuery,
  type SearchableExpense,
} from "~/lib/expense-search";
import type { Expense } from "~/lib/types";

/** Conversational AI (the insights query translator) is for accounts
 * with a billing plan ("paid" or "gratis"); null = no plan yet. */
export function accountHasAI(plan: string | null | undefined): boolean {
  return plan === "paid" || plan === "gratis";
}

/** The flattened expense row the insights page charts: the search-box view
 * plus the fields charting and the drill-down table need (id, date
 * bucket, amount sum). */
export type InsightExpense = SearchableExpense & {
  id: string;
  date: string;
};

export function insightExpense(e: Expense): InsightExpense {
  return {
    id: e.id,
    type: e.type,
    merchant: e.type === "mileage" ? "" : e.merchant,
    mileageType: e.type === "mileage" ? e.mileageType : "business",
    locations: e.type === "mileage" ? e.locations : [],
    description: e.description,
    category: e.category,
    report: e.report,
    amount: e.amount,
    date: e.date,
  };
}

export interface MonthBucket {
  /** "YYYY-MM" */
  key: string;
  /** "Apr" (or "Apr '25" when the window spans years) */
  label: string;
  total: number;
  count: number;
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** The last `months` calendar months ending at `today` (YYYY-MM-DD),
 * oldest first. The window is computed from the caller's `today` because
 * the server runs UTC and must not guess the user's day (the timezone
 * rule) — the insights page passes the browser's `todayDate()`. */
export function monthWindow(today: string, months: number): string[] {
  const [y, m] = today.split("-").map(Number);
  if (!y || !m || !Number.isFinite(months)) return [];
  const keys: string[] = [];
  let year = y;
  let month = m;
  for (let i = 0; i < months; i++) {
    keys.unshift(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return keys;
}

/** The expenses behind the chart: rows matching `query` whose date falls
 * inside the bucket window, newest first (the drill-down table). */
export function matchingExpenses(
  expenses: InsightExpense[],
  query: string,
  buckets: MonthBucket[],
): InsightExpense[] {
  const keys = new Set(buckets.map((b) => b.key));
  const parsed = parseQuery(query);
  return expenses
    .filter(
      (e) => e.date && keys.has(e.date.slice(0, 7)) && matchesSearch(e, parsed),
    )
    .toSorted(
      (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
    );
}

function bucketLabel(key: string, spanYears: boolean): string {
  const [y, m] = key.split("-").map(Number);
  const abbr = MONTH_ABBR[(m ?? 1) - 1] ?? "";
  return spanYears ? `${abbr} '${String(y).slice(2)}` : abbr;
}

/** Monthly totals for the expenses matching `query` (the same search
 * syntax the home box uses), bucketed by expense date over the window.
 * Expenses outside the window (future-dated, or older than `months`) are
 * ignored; "" amounts count as 0. */
export function monthlyTotals(
  expenses: InsightExpense[],
  query: string,
  today: string,
  months: number,
): MonthBucket[] {
  const spanYears = monthWindow(today, months).some(
    (k) => !k.startsWith(today.slice(0, 4)),
  );
  const spanAll = months <= 0;
  const keys = spanAll
    ? allTimeWindow(expenses, today)
    : monthWindow(today, months);
  const byKey = new Map<string, MonthBucket>(
    keys.map((k) => [
      k,
      {
        key: k,
        label: bucketLabel(k, spanYears || spanAll),
        total: 0,
        count: 0,
      },
    ]),
  );
  const parsed = parseQuery(query);
  for (const e of expenses) {
    if (!e.date || !matchesSearch(e, parsed)) continue;
    const bucket = byKey.get(e.date.slice(0, 7));
    if (!bucket) continue;
    bucket.total += Number(e.amount) || 0;
    bucket.count += 1;
  }
  return keys.map((k) => byKey.get(k)!);
}

/** All-time window: every month from the oldest expense to `today`'s
 * month, oldest first (empty when there are no dated expenses). */
function allTimeWindow(expenses: InsightExpense[], today: string): string[] {
  const dated = expenses
    .map((e) => e.date)
    .filter((d) => /^\d{4}-\d{2}/.test(d));
  if (dated.length === 0) return monthWindow(today, 1);
  const first = dated.toSorted()[0]!.slice(0, 7);
  const [fy, fm] = first.split("-").map(Number);
  const [ty, tm] = today.split("-").map(Number);
  const count = (ty! - fy!) * 12 + (tm! - fm!) + 1;
  return monthWindow(today, Math.max(1, count));
}

/** The computed numbers behind a chart (or a text answer): totals, the
 * monthly breakdown, and the biggest merchants — formatted for the
 * answer model, which phrases it but must never invent figures. */
export function insightSummary(
  buckets: MonthBucket[],
  matched: InsightExpense[],
): string {
  const total = buckets.reduce((sum, b) => sum + b.total, 0);
  const lines = [
    `Total: $${total.toFixed(2)} across ${matched.length} expenses`,
  ];
  const byMonth = buckets
    .filter((b) => b.count > 0)
    .map((b) => `${b.label}: $${b.total.toFixed(2)} (${b.count} expenses)`);
  if (byMonth.length > 0) lines.push(`By month: ${byMonth.join("; ")}`);
  const byMerchant = new Map<string, { total: number; count: number }>();
  for (const e of matched) {
    if (!e.merchant) continue;
    const entry = byMerchant.get(e.merchant) ?? { total: 0, count: 0 };
    entry.total += Number(e.amount) || 0;
    entry.count += 1;
    byMerchant.set(e.merchant, entry);
  }
  const top = [...byMerchant.entries()]
    .toSorted((a, b) => b[1].total - a[1].total)
    .slice(0, 5)
    .map(
      ([name, v]) => `${name}: $${v.total.toFixed(2)} (${v.count} expenses)`,
    );
  if (top.length > 0) lines.push(`Top merchants: ${top.join("; ")}`);
  return lines.join("\n");
}

/** Merchant context for the AI translator: each distinct merchant with
 * the categories its expenses actually landed in ("Amazon (Books)"),
 * most frequent first. The annotations let the model see that a brand
 * selling AI services still has non-AI expenses here. */
export function knownMerchants(expenses: InsightExpense[]): string[] {
  const stats = new Map<
    string,
    { count: number; categories: Map<string, number> }
  >();
  for (const e of expenses) {
    if (e.type !== "receipt" || !e.merchant) continue;
    const entry = stats.get(e.merchant) ?? {
      count: 0,
      categories: new Map<string, number>(),
    };
    entry.count += 1;
    if (e.category) {
      entry.categories.set(
        e.category,
        (entry.categories.get(e.category) ?? 0) + 1,
      );
    }
    stats.set(e.merchant, entry);
  }
  return [...stats.entries()]
    .toSorted((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([name, { categories }]) => {
      const top = [...categories.entries()]
        .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 2)
        .map(([category]) => category);
      return top.length > 0 ? `${name} (${top.join(", ")})` : name;
    });
}
