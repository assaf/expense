/**
 * Natural-language periods → concrete date ranges, for the insights
 * question flow.
 *
 * This module OWNS the period: the translator is told not to emit date
 * operators, and a range resolved here REPLACES whatever the model
 * produced. It also owns the chart decision — a window inside one calendar
 * month (a day, a week, a rolling 30 days) has no month-to-month shape to
 * plot, so it is answered as text; quarters, years and multi-month ranges
 * chart. One owner for scope, one for shape.
 *
 * Pure and timezone-free: dates are plain YYYY-MM-DD strings computed from
 * the CLIENT's local today (the server must not guess the user's day).
 * Weeks start on Sunday, the app's audience convention.
 */

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

export interface DateRange {
  after: string;
  before: string;
}

/** The range plus the shape of the window: the chart decision and the
 * month count the chart/buckets should span (see the module comment). */
export interface PeriodScope extends DateRange {
  chart: boolean;
  months: number;
}

/** How the range was asked for. Only the shape of the window matters for
 * the chart decision: days and weeks are too granular to plot monthly, a
 * single month has no month-to-month comparison, and multi-month windows
 * do. */
type PeriodKind =
  | "day"
  | "week"
  | "month"
  | "months"
  | "quarter"
  | "year"
  | "explicit";

const CHART_KINDS: ReadonlySet<PeriodKind> = new Set([
  "months",
  "quarter",
  "year",
]);

/** Noon UTC keeps the calendar date stable under any host timezone. */
function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function lastOfMonth(iso: string): string {
  const d = new Date(`${firstOfMonth(iso)}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${firstOfMonth(iso)}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Sunday of the week containing `iso`. */
function startOfWeek(iso: string): string {
  const day = new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return shift(iso, -day);
}

/** First day of the quarter containing `iso`, `offset` quarters away. */
function firstOfQuarter(iso: string, offset = 0): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const start = Math.floor((month - 1) / 3) * 3 + 1 + offset * 3;
  return new Date(Date.UTC(year, start - 1, 1, 12)).toISOString().slice(0, 10);
}

/** Calendar months an inclusive range touches. */
function monthsSpanned({ after, before }: DateRange): number {
  const a = Number(after.slice(0, 4)) * 12 + Number(after.slice(5, 7));
  const b = Number(before.slice(0, 4)) * 12 + Number(before.slice(5, 7));
  return b - a + 1;
}

function resolve(
  question: string,
  today: string,
): (DateRange & { kind: PeriodKind }) | null {
  const q = question.toLowerCase();

  // Explicit dates win over everything: the user named them.
  const between =
    /\b(?:from|between)\s+(20\d{2}-\d{2}-\d{2})\s+(?:to|and|through|until)\s+(20\d{2}-\d{2}-\d{2})\b/.exec(
      q,
    );
  if (between) {
    return { after: between[1]!, before: between[2]!, kind: "explicit" };
  }
  const since = /\b(?:since|after|from)\s+(20\d{2}-\d{2}-\d{2})\b/.exec(q);
  const until =
    /\b(?:until|before|through|up to)\s+(20\d{2}-\d{2}-\d{2})\b/.exec(q);
  if (since || until) {
    const range = {
      after: since?.[1] ?? `${today.slice(0, 4)}-01-01`,
      before: until?.[1] ?? today,
    };
    return { ...range, kind: monthsSpanned(range) > 1 ? "explicit" : "day" };
  }

  // Quarters, calendar-aligned.
  if (/\b(?:this|current) quarter\b/.test(q)) {
    return { after: firstOfQuarter(today), before: today, kind: "quarter" };
  }
  if (/\b(?:last|previous) quarter\b/.test(q)) {
    const after = firstOfQuarter(today, -1);
    return {
      after,
      before: lastOfMonth(addMonths(after, 2)),
      kind: "quarter",
    };
  }
  const quarter = /\bq([1-4])(?:\s+(20\d{2}))?\b/.exec(q);
  if (quarter) {
    const start = `${quarter[2] ?? today.slice(0, 4)}-${String(
      (Number(quarter[1]) - 1) * 3 + 1,
    ).padStart(2, "0")}-01`;
    return {
      after: start,
      before: lastOfMonth(addMonths(start, 2)),
      kind: "quarter",
    };
  }

  // Year to date.
  if (/\b(?:so far|to date|year to date|ytd)\b/.test(q)) {
    return {
      after: `${today.slice(0, 4)}-01-01`,
      before: today,
      kind: "year",
    };
  }

  // Named periods, most specific first.
  if (/\blast week\b/.test(q)) {
    const start = shift(startOfWeek(today), -7);
    return { after: start, before: shift(start, 6), kind: "week" };
  }
  if (/\bthis week\b/.test(q)) {
    return { after: startOfWeek(today), before: today, kind: "week" };
  }
  if (/\blast month\b/.test(q)) {
    const start = addMonths(today, -1);
    return { after: start, before: lastOfMonth(start), kind: "month" };
  }
  if (/\bthis month\b/.test(q)) {
    return { after: firstOfMonth(today), before: today, kind: "month" };
  }
  if (/\blast year\b/.test(q)) {
    const year = Number(today.slice(0, 4)) - 1;
    return {
      after: `${year}-01-01`,
      before: `${year}-12-31`,
      kind: "year",
    };
  }
  if (/\bthis year\b/.test(q)) {
    return { after: `${today.slice(0, 4)}-01-01`, before: today, kind: "year" };
  }

  // Rolling windows: "last 30 days", "past 2 weeks", "last 3 months".
  // Inclusive of today, so N days means today and the N-1 before it.
  const rolling =
    /\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month)s?\b/.exec(q);
  if (rolling) {
    const n = Number(rolling[1]);
    if (n > 0) {
      const unit = rolling[2]!;
      if (unit === "day") {
        return { after: shift(today, -(n - 1)), before: today, kind: "day" };
      }
      if (unit === "week") {
        return {
          after: shift(today, -(n * 7 - 1)),
          before: today,
          kind: "week",
        };
      }
      return {
        after: addMonths(today, -n),
        before: today,
        kind: n >= 2 ? "months" : "month",
      };
    }
  }

  if (/\btoday\b|\btonight\b/.test(q)) {
    return { after: today, before: today, kind: "day" };
  }
  if (/\byesterday\b/.test(q)) {
    const d = shift(today, -1);
    return { after: d, before: d, kind: "day" };
  }

  const named = new RegExp(
    `\\b(?:in|during|for|since)\\s+(${MONTHS.join("|")})(?:\\s+(\\d{4}))?\\b`,
  ).exec(q);
  if (named) {
    const monthIndex = MONTHS.indexOf(named[1]!) + 1;
    // A bare month name means the most recent one: this year if it has
    // already started, last year otherwise.
    const year = named[2]
      ? Number(named[2])
      : monthIndex <= Number(today.slice(5, 7))
        ? Number(today.slice(0, 4))
        : Number(today.slice(0, 4)) - 1;
    const start = `${year}-${String(monthIndex).padStart(2, "0")}-01`;
    return { after: start, before: lastOfMonth(start), kind: "month" };
  }

  return null;
}

/** The range a question's period words pin down, or null when it names no
 * period this module recognises (the caller then leaves the query alone). */
export function periodRange(question: string, today: string): DateRange | null {
  const hit = resolve(question, today);
  return hit ? { after: hit.after, before: hit.before } : null;
}

/** The range plus the chart decision (see the module comment). */
export function periodScope(
  question: string,
  today: string,
): PeriodScope | null {
  const hit = resolve(question, today);
  if (!hit) return null;
  return {
    after: hit.after,
    before: hit.before,
    // An explicit range spanning more than one month is a trend too.
    chart:
      CHART_KINDS.has(hit.kind) ||
      (hit.kind === "explicit" && monthsSpanned(hit) > 1),
    // The buckets (and the chart's axis) span exactly the range's months,
    // so a quarter question plots three bars over a three-month axis rather
    // than the model's twelve. Clamped: a decade-long range still renders,
    // just without hundreds of empty buckets.
    months: Math.min(60, Math.max(1, monthsSpanned(hit))),
  };
}

/** Drop any date tokens a previous parse produced, so the app's range is
 * the only one in the query. */
function stripDateRange(query: string): string {
  return query
    .replace(/\b(?:after|since|before|until):\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Apply the app's period to a translated query. When the question names a
 * period this module resolves, that range is authoritative (the model's own
 * is discarded); otherwise the query is returned untouched and the model's
 * range — or the query tool — remains the fallback. */
export function withPeriodRange(
  query: string,
  question: string,
  today: string,
): string {
  const range = periodRange(question, today);
  if (!range) return query;
  const parts = [
    stripDateRange(query),
    `after:${range.after}`,
    `before:${range.before}`,
  ];
  return parts.filter(Boolean).join(" ");
}
