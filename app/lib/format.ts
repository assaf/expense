/** Formatting helpers shared across server and client. */

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

/** True when the date is today or in the past. Empty is allowed (incomplete). */
export function isDateValidOrPast(date: string): boolean {
  if (!date) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date <= todayDate();
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
