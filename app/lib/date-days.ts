/** UTC-day arithmetic over "YYYY-MM-DD" strings, shared by the warranty
 * expiry groups, the reconcile tolerance checks and the insight starters:
 * one definition of the parse (strict shape, UTC midnight) instead of one
 * per module. Client-safe: pure functions, no server imports. */

/** Midnight UTC for a "YYYY-MM-DD" date, or null when malformed. */
function utcDay(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : ms;
}

/** Whole days from `from` to `to` ("YYYY-MM-DD" each), or null when either
 * is malformed. Negative when `to` is before `from`. */
export function daysBetween(from: string, to: string): number | null {
  const a = utcDay(from);
  const b = utcDay(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The date `days` away from a "YYYY-MM-DD" date. A malformed input is
 * echoed unchanged: callers that already validated the date never see it. */
export function shiftDays(date: string, days: number): string {
  const ms = utcDay(date);
  if (ms === null) return date;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}
