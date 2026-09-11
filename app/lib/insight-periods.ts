/**
 * Natural-language periods → concrete date ranges, for the insights
 * question flow. The translator is asked to emit `after:`/`before:`
 * itself, but a missing or wrong range is the single most common way an
 * answer goes hunting for data it was never given ("which reports did I
 * spend on this month?" against a year-wide breakdown), so the action
 * applies this deterministic net over its output.
 *
 * Pure and timezone-free: dates are plain YYYY-MM-DD strings, computed
 * from the CLIENT's local today (the server must not guess the user's
 * day). Weeks start on Sunday, the app's audience convention.
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

/** The range a question's period words pin down, or null when it names no
 * period (the caller then leaves the translator's query alone). */
export function periodRange(question: string, today: string): DateRange | null {
  const q = question.toLowerCase();
  const month = `(${MONTHS.join("|")})`;
  // Most specific first: "last week" must win over "week" phrasing, and
  // the month-name form must not swallow "this month".
  if (/\blast week\b/.test(q)) {
    const start = shift(startOfWeek(today), -7);
    return { after: start, before: shift(start, 6) };
  }
  if (/\bthis week\b/.test(q)) {
    return { after: startOfWeek(today), before: today };
  }
  if (/\blast month\b/.test(q)) {
    const start = addMonths(today, -1);
    return { after: start, before: lastOfMonth(start) };
  }
  if (/\bthis month\b/.test(q)) {
    return { after: firstOfMonth(today), before: today };
  }
  if (/\blast year\b/.test(q)) {
    const year = Number(today.slice(0, 4)) - 1;
    return { after: `${year}-01-01`, before: `${year}-12-31` };
  }
  if (/\bthis year\b/.test(q)) {
    return { after: `${today.slice(0, 4)}-01-01`, before: today };
  }
  if (/\btoday\b|\btonight\b/.test(q)) return { after: today, before: today };
  if (/\byesterday\b/.test(q)) {
    const d = shift(today, -1);
    return { after: d, before: d };
  }
  const named = new RegExp(
    `\\b(?:in|during|for)\\s+${month}(?:\\s+(\\d{4}))?\\b`,
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
    return { after: start, before: lastOfMonth(start) };
  }
  return null;
}

/** Apply a detected period to a translated query: the range is appended
 * unless the query already carries one (the model's own range wins, so a
 * refined question like "since the 3rd" is not overridden). */
export function withPeriodRange(
  query: string,
  question: string,
  today: string,
): string {
  if (/\b(after|since|before|until):/.test(query)) return query;
  const range = periodRange(question, today);
  if (!range) return query;
  const parts = [
    query.trim(),
    `after:${range.after}`,
    `before:${range.before}`,
  ];
  return parts.filter(Boolean).join(" ");
}
