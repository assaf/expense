import Decimal from "decimal.js";
import {
  matchesSearch,
  parseQuery,
  type SearchableExpense,
} from "~/lib/expense-search";
import { countLabel, formatUsd } from "~/lib/format";
import { parseAmount } from "~/lib/money";
import type { Expense } from "~/lib/types";

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

/** The window of calendar months the chart buckets: the last `months`
 * months ending at `today`, or -1 for this calendar year so far (Jan
 * through `today`'s month). Oldest first. The window is computed from
 * the caller's `today` because the server runs UTC and must not guess
 * the user's day (the timezone rule) — the insights page passes the
 * browser's `todayDate()`. */
export function monthWindow(today: string, months: number): string[] {
  const [y, m] = today.split("-").map(Number);
  if (!y || !m || !Number.isFinite(months)) return [];
  if (months === -1) {
    const keys: string[] = [];
    for (let month = 1; month <= m; month++) {
      keys.push(`${y}-${String(month).padStart(2, "0")}`);
    }
    return keys;
  }
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
  const spanAll = months === 0;
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

/** "YYYY-MM" → its parts, or null when either is not a finite number. */
function parseMonthKey(key: string): { year: number; month: number } | null {
  const [year, month] = key.split("-").map(Number);
  if (year === undefined || month === undefined) return null;
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  return { year, month };
}

/** All-time window: every month from the oldest expense to `today`'s
 * month, oldest first (empty when there are no dated expenses). */
function allTimeWindow(expenses: InsightExpense[], today: string): string[] {
  const dated = expenses
    .map((e) => e.date)
    .filter((d) => /^\d{4}-\d{2}/.test(d));
  const oldest = dated.toSorted()[0];
  if (!oldest) return monthWindow(today, 1);
  const first = parseMonthKey(oldest.slice(0, 7));
  const last = parseMonthKey(today);
  // The caller always sends a full date, but the window must not depend on
  // that: an unparseable end would make the month count NaN and blank the
  // chart instead of degrading to a single month.
  if (!first || !last) return monthWindow(today, 1);
  // A single ancient date (a forwarded receipt's Date: header, or a typed one)
  // must not turn into a chart with tens of thousands of buckets: same 60-month
  // cap the question-derived windows use (insight-periods.ts).
  const count = Math.min(
    60,
    (last.year - first.year) * 12 + (last.month - first.month) + 1,
  );
  return monthWindow(today, Math.max(1, count));
}

/** The computed numbers behind a chart (or a text answer): totals, the
 * monthly breakdown, and the biggest merchants — formatted for the
 * answer model, which phrases it but must never invent figures.
 *
 * Every printed figure is accumulated with decimal.js: the bucket totals
 * above are chart geometry (display-only numbers), and a cent that drifts
 * between the chart and the ledger is exactly the kind of "fact" the model
 * reads back to the user. */
export function insightSummary(
  buckets: MonthBucket[],
  matched: InsightExpense[],
): string {
  const zero = new Decimal(0);
  const amountOf = (e: InsightExpense): Decimal =>
    parseAmount(e.amount) ?? zero;
  const byMonth = new Map<string, Decimal>();
  for (const e of matched) {
    const key = e.date.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? zero).add(amountOf(e)));
  }
  const total = [...byMonth.values()].reduce((sum, v) => sum.add(v), zero);
  const lines = [
    `Total: $${total.toFixed(2)} across ${matched.length} expenses`,
  ];
  const monthLines = buckets
    .filter((b) => b.count > 0)
    .map(
      (b) =>
        `${b.label}: $${(byMonth.get(b.key) ?? zero).toFixed(2)} (${b.count} expenses)`,
    );
  if (monthLines.length > 0) lines.push(`By month: ${monthLines.join("; ")}`);

  /** Group the matched rows by one dimension, with exact totals. */
  const byDimension = (
    field: (e: InsightExpense) => string,
  ): Map<string, { total: Decimal; count: number }> => {
    const map = new Map<string, { total: Decimal; count: number }>();
    for (const e of matched) {
      const key = field(e);
      if (!key) continue;
      const entry = map.get(key) ?? { total: zero, count: 0 };
      entry.total = entry.total.add(amountOf(e));
      entry.count += 1;
      map.set(key, entry);
    }
    return map;
  };
  const topLines = (
    map: Map<string, { total: Decimal; count: number }>,
  ): string[] =>
    [...map.entries()]
      .toSorted((a, b) => b[1].total.comparedTo(a[1].total))
      .slice(0, 5)
      .map(
        ([name, v]) => `${name}: $${v.total.toFixed(2)} (${v.count} expenses)`,
      );

  const merchants = topLines(byDimension((e) => e.merchant));
  if (merchants.length > 0)
    lines.push(`Top merchants: ${merchants.join("; ")}`);
  const categories = topLines(byDimension((e) => e.category));
  if (categories.length > 0) {
    lines.push(`By category: ${categories.join("; ")}`);
  }
  // Report is a first-class dimension on every row (and on the query
  // tool's results), so the summary must break it out too: without it,
  // "which report did I spend most on?" has no report-level data to read.
  const reports = topLines(byDimension((e) => e.report));
  if (reports.length > 0) lines.push(`By report: ${reports.join("; ")}`);
  const unreported = matched.filter((e) => !e.report).length;
  if (unreported > 0) {
    lines.push(`Not in any report: ${unreported} expenses`);
  }
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

/** Stop addresses from the most recent mileage rows, the home address
 * excluded: hints for resolving "the office" when no work address is set.
 * Newest trip first (id as the tie-break, so the order is deterministic),
 * distinct addresses (case-insensitive), capped at `limit`. Reads nothing:
 * `insightExpense` already puts `locations` on the snapshot. Pure. */
export function recentTripStops(
  expenses: readonly InsightExpense[],
  homeAddress: string,
  limit = 8,
): string[] {
  const home = homeAddress.trim().toLowerCase();
  const seen = new Set<string>(home ? [home] : []);
  const stops: string[] = [];
  const trips = expenses
    .filter(
      (e) =>
        e.type === "mileage" &&
        e.locations.filter((l) => l.address.trim() !== "").length >= 2,
    )
    .toSorted(
      (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
    );
  for (const trip of trips) {
    for (const { address } of trip.locations) {
      const stop = address.trim();
      const key = stop.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      stops.push(stop);
      if (stops.length >= limit) return stops;
    }
  }
  return stops;
}

/** A computed Q&A the page opens with (the "start with an answer"
 * pattern): one fact about the account's actual data, phrased as the
 * question that would produce it. Computed client-side from the already
 * loaded expenses and the browser's local today, so no server "today"
 * and no LLM call is involved. */
export interface InsightStarter {
  question: string;
  answer: string;
}

function shiftDays(today: string, days: number): string {
  const [y, m, d] = today.split("-").map(Number);
  if (!y || !m || !d) return today;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function starterLabel(e: InsightExpense): string {
  return (
    e.merchant ||
    e.description ||
    (e.type === "mileage" ? "Mileage" : "Expense")
  );
}

/** The fact pool for the opening card. Only facts with something to say
 * make the pool, so an empty account keeps the plain empty state. */
export function insightStarters(
  expenses: InsightExpense[],
  today: string,
): InsightStarter[] {
  const dated = expenses.filter((e) => e.date);
  const inWindow = (from: string) =>
    dated.filter((e) => e.date >= from && e.date <= today);
  const total = (list: InsightExpense[]) =>
    list.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const year = today.slice(0, 4);
  const starters: InsightStarter[] = [];

  const last30 = inWindow(shiftDays(today, -30));
  if (last30.length > 0) {
    starters.push({
      question: "How much have I spent in the last 30 days?",
      answer: `${countLabel(last30.length)} totaling ${formatUsd(total(last30))} in the last 30 days.`,
    });
  }

  const thisYear = dated.filter(
    (e) => e.date.startsWith(year) && e.date <= today,
  );
  if (thisYear.length > 0) {
    starters.push({
      question: "How much have I spent this year?",
      answer: `So far this year: ${countLabel(thisYear.length)} totaling ${formatUsd(total(thisYear))}.`,
    });
  }

  const biggest = inWindow(shiftDays(today, -90)).sort(
    (a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0),
  )[0];
  if (biggest) {
    const bits = [starterLabel(biggest)];
    if (biggest.category) bits.push(biggest.category);
    starters.push({
      question: "What's my biggest expense?",
      answer: `Your biggest expense in the last 90 days is ${formatUsd(Number(biggest.amount) || 0)}: ${bits.join(" · ")}.`,
    });
  }

  const byReport = new Map<string, InsightExpense[]>();
  for (const e of thisYear) {
    if (!e.report) continue;
    const list = byReport.get(e.report) ?? [];
    list.push(e);
    byReport.set(e.report, list);
  }
  const topReport = [...byReport.entries()].sort(
    (a, b) => total(b[1]) - total(a[1]),
  )[0];
  if (topReport) {
    starters.push({
      question: "Which report is the biggest this year?",
      answer: `${topReport[0]} leads this year's reports: ${countLabel(topReport[1].length)} worth ${formatUsd(total(topReport[1]))}.`,
    });
  }

  const unfiled = dated.filter((e) => !e.report);
  if (unfiled.length > 0) {
    starters.push({
      question: "What still needs a report?",
      answer: `${countLabel(unfiled.length)} worth ${formatUsd(total(unfiled))} ${unfiled.length === 1 ? "has" : "have"} no report yet.`,
    });
  }

  const byCategory = new Map<string, InsightExpense[]>();
  for (const e of inWindow(shiftDays(today, -90))) {
    if (!e.category) continue;
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }
  const topCategory = [...byCategory.entries()].sort(
    (a, b) => total(b[1]) - total(a[1]),
  )[0];
  if (topCategory) {
    starters.push({
      question: "Where does my money go?",
      answer: `Your top category in the last 90 days is ${topCategory[0]}: ${formatUsd(total(topCategory[1]))} across ${countLabel(topCategory[1].length)}.`,
    });
  }

  return starters;
}

/** One starter per visit, so the opening fact changes from visit to
 * visit. `rng` is injectable for tests. */
export function pickStarter(
  starters: InsightStarter[],
  rng: () => number = Math.random,
): InsightStarter | null {
  if (starters.length === 0) return null;
  return starters[Math.floor(rng() * starters.length)] ?? starters[0];
}

/** Typewriter reveal pacing: short answers stream at REVEAL_MIN_CPS;
 * long ones are scaled down so the reveal finishes within REVEAL_MAX_MS
 * and never feels like a slow crawl. */
const REVEAL_MIN_CPS = 300;
const REVEAL_MAX_MS = 3500;

/** Advance a typewriter reveal through `full` after `ms` elapsed,
 * snapping the cut to a word boundary so words appear whole (the cut
 * lands just before the next word starts). Pure; unit-tested. */
export function revealTo(full: string, pos: number, ms: number): number {
  if (pos >= full.length) return full.length;
  const cps = Math.max(REVEAL_MIN_CPS, (full.length * 1000) / REVEAL_MAX_MS);
  let next = pos + Math.max(1, Math.round((cps * ms) / 1000));
  if (next < full.length) {
    const space = full.indexOf(" ", next);
    next = space === -1 ? full.length : space;
  }
  return Math.min(next, full.length);
}
