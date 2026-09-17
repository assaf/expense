import Decimal from "decimal.js";

import { hasAmount } from "~/lib/completeness";
import { groupDuplicateMatches, normalizeMerchant } from "~/lib/duplicates";
import { countLabel, formatUsd } from "~/lib/format";
import type { InsightExpense } from "~/lib/insights";
import { parseAmount } from "~/lib/money";

/**
 * The money checkup: what the account's own records say is outstanding.
 *
 * Every finding is a comparison inside the account's rows, never a
 * benchmark the app invented, so a small account gets small findings and a
 * clean one gets none. The window is the calendar year to date, and the
 * one exception is the incomplete-rows finding: a row with no date can
 * never be placed in a year, so that one covers the whole account.
 *
 * Pure and isomorphic (no DB, no React), so the page computes it on the
 * client from the loader's expense snapshot, the action computes it on the
 * server to hand the answer step the same block, and the opening starter
 * reads it. Every figure a user or the model sees is computed here; the
 * unit test is the contract.
 */

type CheckupKind =
  | "incomplete"
  | "no-category"
  | "no-report"
  | "duplicates"
  | "no-image"
  | "recurring"
  | "drift"
  | "mileage";

/** One row the panel can link to. `amount` is already formatted, and is ""
 * when the row has no amount to show (a row flagged for a missing amount
 * must not print $0.00 as if that were its value). */
interface CheckupRowLink {
  id: string;
  /** merchant | description | "Mileage" | "Expense" */
  label: string;
  /** "$24.00", or "$24.00/mo" for a repeating charge. */
  amount: string;
}

export interface CheckupFinding {
  kind: CheckupKind;
  /** Headline carrying the exact figures, e.g.
   * "4 expenses worth $212.40 with no category". */
  title: string;
  /** One sentence: what it means, never advice about how to live. */
  detail: string;
  /** The names behind the number ("" when the title says it all):
   * "Northwind $24.00/mo, Acme Cloud $45.00/mo". */
  facts: string;
  /** Dollars involved (0 when the finding has no figure of its own). */
  amount: number;
  /** Rows the finding counts: expenses, duplicate pairs, repeating
   * charges, or the trips those years did log. */
  count: number;
  /** Up to 3 example rows, newest first. */
  links: CheckupRowLink[];
  /** The page that owns the fix, when one exists. */
  action?: { label: string; href: string };
}

interface CheckupPace {
  annual: number;
  spent: number;
  elapsedDays: number;
}

export interface Checkup {
  /** "2026-01-01" */
  since: string;
  /** The caller's local date. */
  until: string;
  spent: number;
  count: number;
  /** Severity order (the array order, fixed by construction): what cannot
   * be filed at all, then the fields a claim needs, then the money
   * findings. */
  findings: CheckupFinding[];
  pace: CheckupPace | null;
}

export function moneyCheckup(input: {
  expenses: readonly InsightExpense[];
  /** The browser's local date, YYYY-MM-DD. Anything else yields an empty
   * checkup: the window is a calendar year, and the server must not guess
   * the user's day. */
  today: string;
  /** Dismissed duplicate pair keys (readDuplicateDismissals). */
  dismissed?: ReadonlySet<string>;
}): Checkup {
  const { expenses, today, dismissed } = input;
  if (!DATE.test(today)) {
    return {
      since: "",
      until: today,
      spent: 0,
      count: 0,
      findings: [],
      pace: null,
    };
  }
  const since = `${today.slice(0, 4)}-01-01`;
  // Dates are YYYY-MM-DD, so the string comparison is the date
  // comparison, and a row with no date is in no window.
  const window = expenses.filter((e) => e.date >= since && e.date <= today);
  const spent = sumAmounts(window);

  const findings: CheckupFinding[] = [];
  for (const finding of [
    incompleteFinding(expenses),
    categoryFinding(window),
    reportFinding(window),
    duplicateFinding(window, dismissed),
    imageFinding(window),
    recurringFinding(window),
    driftFinding(expenses, window, today, spent),
    mileageFinding(expenses, window, since),
  ]) {
    if (finding) findings.push(finding);
  }

  const elapsedDays = dayCount(since, today);
  const pace =
    elapsedDays !== null && elapsedDays >= PACE_MIN_DAYS
      ? {
          annual: spent.div(elapsedDays).mul(365).toNumber(),
          spent: spent.toNumber(),
          elapsedDays,
        }
      : null;

  return {
    since,
    until: today,
    spent: spent.toNumber(),
    count: window.length,
    findings,
    pace,
  };
}

/** The sentence both the panel and the model block use for a clean year:
 * one string, so they cannot drift apart. */
export const NOTHING_OUTSTANDING =
  "Nothing outstanding: every expense has a category and a report, and no receipt is missing its image.";

/** The block the answer step reads. Pure, so its exact lines are tested. */
export function checkupText(checkup: Checkup): string {
  const lines = [
    `Money checkup (whole account, ${checkup.since} to ${checkup.until}; ignores the chart filter):`,
    `Spent: ${formatUsd(checkup.spent)} across ${countLabel(checkup.count)}`,
  ];
  if (checkup.findings.length === 0) {
    lines.push(`- ${NOTHING_OUTSTANDING}`);
  } else {
    for (const finding of checkup.findings) {
      lines.push(
        `- ${finding.title}${finding.facts ? ` (${finding.facts})` : ""}`,
      );
    }
  }
  if (checkup.pace) {
    lines.push(
      `At this rate: about ${formatUsd(checkup.pace.annual)} by December 31 (a straight line from ${formatUsd(checkup.pace.spent)} in ${checkup.pace.elapsedDays} days)`,
    );
  }
  return lines.join("\n");
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const ZERO = new Decimal(0);
/** How many example rows a finding links, and how many names its facts line
 * carries: enough to act on, short enough to read. */
const MAX_LINKS = 3;
/** A charge repeats monthly when the median gap between its dates sits in
 * this window: a month is 28 to 31 days, and a weekend's drift must not
 * hide a subscription. */
const RECURRING_MIN_DAYS = 25;
const RECURRING_MAX_DAYS = 35;
/** And its prices vary by no more than a quarter: a rate change, not a
 * different purchase. */
const RECURRING_MAX_SPREAD = new Decimal("1.25");
/** Year-over-year movement worth reporting. Below this the checkup stays
 * quiet about ordinary variation. */
const DRIFT_MIN_FRACTION = new Decimal("0.10");
/** A straight line needs a few months behind it before it says anything. */
const PACE_MIN_DAYS = 45;

/** Rows with no date or no amount, over the whole account: a row without a
 * date can never be placed in a year window, so this is the one finding
 * that ignores it. */
function incompleteFinding(
  expenses: readonly InsightExpense[],
): CheckupFinding | null {
  const rows = expenses.filter((e) => !e.date || !hasAmount(e.amount));
  if (rows.length === 0) return null;
  return {
    kind: "incomplete",
    title: `${countLabel(rows.length)} ${rows.length === 1 ? "is" : "are"} missing an amount or a date`,
    detail: "Without both, the expense cannot be filed or claimed.",
    facts: "",
    amount: sumAmounts(rows).toNumber(),
    count: rows.length,
    links: linksOf(rows),
  };
}

function categoryFinding(
  window: readonly InsightExpense[],
): CheckupFinding | null {
  const rows = window.filter((e) => e.category.trim() === "");
  if (rows.length === 0) return null;
  const total = sumAmounts(rows);
  return {
    kind: "no-category",
    title: `${countLabel(rows.length)} worth ${formatUsd(total.toNumber())} with no category`,
    detail:
      "A category is what makes an expense claimable; without one it has to be guessed.",
    facts: "",
    amount: total.toNumber(),
    count: rows.length,
    links: linksOf(rows),
  };
}

function reportFinding(
  window: readonly InsightExpense[],
): CheckupFinding | null {
  const rows = window.filter((e) => e.report.trim() === "");
  if (rows.length === 0) return null;
  const total = sumAmounts(rows);
  return {
    kind: "no-report",
    title: `${countLabel(rows.length)} worth ${formatUsd(total.toNumber())} in no report`,
    detail:
      "Reports are what you hand your accountant, and a report is what the export and the PDF follow.",
    facts: "",
    amount: total.toNumber(),
    count: rows.length,
    links: linksOf(rows),
    action: { label: "Open reports", href: "/export" },
  };
}

/** Pairs the list page would warn about, each counted once: the matcher
 * reports both directions, so a pair is the row with the lower id plus the
 * row that repeats it, and the pair is worth that first row's amount. */
function duplicateFinding(
  window: readonly InsightExpense[],
  dismissed?: ReadonlySet<string>,
): CheckupFinding | null {
  const matches = groupDuplicateMatches(window, dismissed);
  // The row that came first in each pair; the pair's second row is the
  // evidence the matcher already read.
  const pairs: InsightExpense[] = [];
  for (const row of window) {
    const list = matches.get(row.id);
    if (!list) continue;
    for (const match of list) {
      if (row.id < match.expense.id) pairs.push(row);
    }
  }
  if (pairs.length === 0) return null;
  const ordered = pairs.toSorted(
    (a, b) =>
      amountOf(b).comparedTo(amountOf(a)) ||
      b.date.localeCompare(a.date) ||
      a.id.localeCompare(b.id),
  );
  const total = pairs.reduce((sum, row) => sum.add(amountOf(row)), ZERO);
  return {
    kind: "duplicates",
    title: `${pairs.length} suspected duplicate pair${pairs.length === 1 ? "" : "s"} worth ${formatUsd(total.toNumber())}`,
    detail:
      "Two rows that describe one entry inflate the total and double-claim the deduction.",
    facts: "",
    amount: total.toNumber(),
    count: pairs.length,
    links: ordered.slice(0, MAX_LINKS).map(link),
  };
}

function imageFinding(
  window: readonly InsightExpense[],
): CheckupFinding | null {
  const rows = window.filter((e) => e.type === "receipt" && !e.hasImage);
  if (rows.length === 0) return null;
  const total = sumAmounts(rows);
  return {
    kind: "no-image",
    title: `${countLabel(rows.length)} worth ${formatUsd(total.toNumber())} with no image on file`,
    detail:
      "The image is the evidence behind the amount; mileage rows are exempt.",
    facts: "",
    amount: total.toNumber(),
    count: rows.length,
    links: linksOf(rows),
  };
}

/** Charges that repeat monthly: three dated charges from one merchant at a
 * monthly cadence and a steady price. The yearly figure is the median
 * month times twelve, so one pricier month does not inflate it. */
function recurringFinding(
  window: readonly InsightExpense[],
): CheckupFinding | null {
  const groups = new Map<
    string,
    Array<{ row: InsightExpense; amount: Decimal }>
  >();
  for (const e of window) {
    if (e.type !== "receipt") continue;
    const key = normalizeMerchant(e.merchant);
    const amount = parseAmount(e.amount);
    // A refund is not a subscription, and an unreadable amount says
    // nothing about the price.
    if (!key || amount === null || !amount.gt(0)) continue;
    const entry = { row: e, amount };
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }

  const repeating: Array<{
    merchant: string;
    monthly: Decimal;
    latest: InsightExpense;
  }> = [];
  for (const entries of groups.values()) {
    // Three charges, by date: two rows on one day are one charge, not a
    // cadence.
    const dates = [...new Set(entries.map((e) => e.row.date))].toSorted();
    if (dates.length < 3) continue;
    const gaps: number[] = [];
    let previous: number | null = null;
    for (const date of dates) {
      const ms = dayMs(date);
      // A row whose date is not a real date cannot establish a cadence.
      if (ms === null) {
        gaps.length = 0;
        break;
      }
      if (previous !== null) gaps.push((ms - previous) / DAY_MS);
      previous = ms;
    }
    if (gaps.length !== dates.length - 1) continue;
    const gap = median(gaps);
    if (gap < RECURRING_MIN_DAYS || gap > RECURRING_MAX_DAYS) continue;

    const amounts = entries
      .map((e) => e.amount)
      .toSorted((a, b) => a.comparedTo(b));
    const cheapest = amounts[0]!;
    const dearest = amounts[amounts.length - 1]!;
    if (dearest.gt(cheapest.mul(RECURRING_MAX_SPREAD))) continue;

    const latest = entries.reduce((newest, e) =>
      e.row.date > newest.row.date ? e : newest,
    ).row;
    repeating.push({
      merchant: latest.merchant.trim(),
      monthly: medianAmount(amounts),
      latest,
    });
  }
  if (repeating.length === 0) return null;

  repeating.sort(
    (a, b) =>
      b.monthly.comparedTo(a.monthly) || a.merchant.localeCompare(b.merchant),
  );
  const yearly = repeating.reduce(
    (sum, group) => sum.add(group.monthly.mul(12)),
    ZERO,
  );
  const top = repeating.slice(0, MAX_LINKS);
  return {
    kind: "recurring",
    title: `${repeating.length} charge${repeating.length === 1 ? "" : "s"} that repeat${repeating.length === 1 ? "s" : ""} monthly, ${formatUsd(yearly.toNumber())} a year`,
    detail:
      "A steady monthly price at a steady cadence is a subscription; the yearly figure is the median month times twelve.",
    facts: top
      .map(
        (group) =>
          `${group.merchant} ${formatUsd(group.monthly.toNumber())}/mo`,
      )
      .join(", "),
    amount: yearly.toNumber(),
    count: repeating.length,
    links: top.map((group) => ({
      id: group.latest.id,
      label: rowLabel(group.latest),
      amount: `${formatUsd(group.monthly.toNumber())}/mo`,
    })),
  };
}

/** This year against the same stretch of last year, and the category that
 * moved most between them. */
function driftFinding(
  expenses: readonly InsightExpense[],
  window: readonly InsightExpense[],
  today: string,
  spent: Decimal,
): CheckupFinding | null {
  const [year, month, day] = today.split("-").map(Number);
  if (!year || !month || !day) return null;
  const priorYear = year - 1;
  // The same calendar date a year back, clamped: February 29 has no
  // counterpart in a common year.
  const priorUntil = `${priorYear}-${pad(month)}-${pad(Math.min(day, daysInMonth(priorYear, month)))}`;
  const priorSince = `${priorYear}-01-01`;
  const prior = expenses.filter(
    (e) => e.date >= priorSince && e.date <= priorUntil,
  );
  const priorTotal = sumAmounts(prior);
  // Both periods need rows and a total to divide by, or a percentage says
  // nothing.
  if (window.length === 0 || prior.length === 0 || !priorTotal.gt(0)) {
    return null;
  }
  const delta = spent.minus(priorTotal);
  const share = delta.abs().div(priorTotal);
  if (share.lt(DRIFT_MIN_FRACTION)) return null;

  const moved = categoryMovement(window, prior);
  return {
    kind: "drift",
    title: `Spending is ${delta.gt(0) ? "up" : "down"} ${share.mul(100).toDecimalPlaces(0).toNumber()}% on the same period last year`,
    detail: `${formatUsd(spent.toNumber())} by this date against ${formatUsd(priorTotal.toNumber())} last year.`,
    facts:
      moved && !moved.delta.isZero()
        ? `${moved.category} moved most, ${signedUsd(moved.delta)}`
        : "",
    amount: delta.abs().toNumber(),
    count: window.length,
    links: [],
  };
}

/** Trips logged before this year, when this year has none: a driver who
 * stopped logging loses the deduction silently, and an account that never
 * drove must not be told it is missing trips. */
function mileageFinding(
  expenses: readonly InsightExpense[],
  window: readonly InsightExpense[],
  since: string,
): CheckupFinding | null {
  if (window.some((e) => e.type === "mileage")) return null;
  const before = expenses.filter(
    (e) => e.type === "mileage" && e.date !== "" && e.date < since,
  ).length;
  if (before === 0) return null;
  return {
    kind: "mileage",
    title: `No trips logged this year (${before} last year)`,
    detail:
      "Business driving is priced at the IRS rate automatically; the trips you do not log are the deduction you do not claim.",
    facts: "",
    amount: 0,
    count: before,
    links: [],
    action: { label: "Log a trip", href: "/expense/new?type=mileage" },
  };
}

/** The category whose total moved furthest between the two periods, by
 * absolute change; ties go to the category that sorts first, so the
 * finding is deterministic. Rows with no category are not a category. */
function categoryMovement(
  current: readonly InsightExpense[],
  prior: readonly InsightExpense[],
): { category: string; delta: Decimal } | null {
  const byCategory = new Map<string, Decimal>();
  for (const [rows, sign] of [
    [current, 1],
    [prior, -1],
  ] as const) {
    for (const e of rows) {
      const category = e.category.trim();
      if (!category) continue;
      byCategory.set(
        category,
        (byCategory.get(category) ?? ZERO).add(amountOf(e).mul(sign)),
      );
    }
  }
  let best: { category: string; delta: Decimal } | null = null;
  for (const [category, delta] of byCategory) {
    const wins =
      !best ||
      delta.abs().gt(best.delta.abs()) ||
      (delta.abs().eq(best.delta.abs()) && category < best.category);
    if (wins) best = { category, delta };
  }
  return best;
}

function linksOf(rows: readonly InsightExpense[]): CheckupRowLink[] {
  return newestFirst(rows).slice(0, MAX_LINKS).map(link);
}

function link(e: InsightExpense): CheckupRowLink {
  return {
    id: e.id,
    label: rowLabel(e),
    amount: hasAmount(e.amount) ? formatUsd(amountOf(e).toNumber()) : "",
  };
}

/** Newest first, so the first example is the most recent one. Rows with no
 * date sort last; the id breaks every tie, so the order never depends on
 * the order the rows arrived in. */
function newestFirst(rows: readonly InsightExpense[]): InsightExpense[] {
  return rows.toSorted(
    (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );
}

function rowLabel(e: InsightExpense): string {
  return (
    e.merchant ||
    e.description ||
    (e.type === "mileage" ? "Mileage" : "Expense")
  );
}

/** The row's amount as an exact Decimal; rows that do not parse count as 0
 * for money and still count as rows. */
function amountOf(e: InsightExpense): Decimal {
  return parseAmount(e.amount) ?? ZERO;
}

function sumAmounts(rows: readonly InsightExpense[]): Decimal {
  let total = ZERO;
  for (const row of rows) total = total.add(amountOf(row));
  return total;
}

/** "$310.00" with the sign in front, for a movement between two periods. */
function signedUsd(value: Decimal): string {
  return `${value.isNegative() ? "-" : "+"}${formatUsd(value.abs().toNumber())}`;
}

/** The middle of a list of numbers (the mean of the two middles when the
 * count is even); 0 for an empty list. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function medianAmount(values: readonly Decimal[]): Decimal {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[middle]!
    : values[middle - 1]!.add(values[middle]!).div(2);
}

/** UTC midnight of a YYYY-MM-DD date, or null when it is not a real date
 * (a day out of range rolls over in Date, which would silently shift a
 * cadence). */
function dayMs(date: string): number | null {
  if (!DATE.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const ms = Date.UTC(year!, month! - 1, day!);
  const at = new Date(ms);
  return at.getUTCFullYear() === year &&
    at.getUTCMonth() === month! - 1 &&
    at.getUTCDate() === day
    ? ms
    : null;
}

/** Days from `from` to `to` inclusive, or null when either is not a real
 * date. */
function dayCount(from: string, to: string): number | null {
  const start = dayMs(from);
  const end = dayMs(to);
  if (start === null || end === null || end < start) return null;
  return (end - start) / DAY_MS + 1;
}

/** The last day of a month, 1-based (Date's day 0 is the day before the
 * 1st of the next month). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
