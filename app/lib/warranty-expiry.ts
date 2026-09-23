/**
 * Warranty expiry math, pure and client-safe (no Prisma, no env, no server
 * imports): the list page groups and badges rows with it, and a unit test
 * reaches it without a browser or a database.
 *
 * Every comparison takes the caller's local `today` ("YYYY-MM-DD") rather
 * than computing one: the server runs UTC, so a server-side "today" is
 * tomorrow for a PST user after 4pm, and loaders must never compute it.
 * Arithmetic goes through Date.UTC so no local-timezone offset can shift a
 * day boundary.
 */

/** How many days ahead a warranty counts as "expiring soon". */
export const EXPIRING_SOON_DAYS = 90;

/** Which list group a warranty belongs to. */
export type WarrantyExpiryGroup = "expired" | "soon" | "later" | "none";

/** Midnight UTC for a "YYYY-MM-DD" date, or null when malformed. */
function utcDay(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : ms;
}

/** Whole days from `from` to `to` ("YYYY-MM-DD" each), or null when either
 * is malformed. Negative when `to` is before `from`. */
function daysBetween(from: string, to: string): number | null {
  const a = utcDay(from);
  const b = utcDay(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000);
}

/** Which list group a warranty belongs to: "" (no end date) and an
 * unparseable date are "none"; before today is "expired"; within
 * EXPIRING_SOON_DAYS inclusive is "soon"; otherwise "later". */
export function warrantyExpiryGroup(
  expiresAt: string,
  today: string,
): WarrantyExpiryGroup {
  if (!expiresAt) return "none";
  const days = daysBetween(today, expiresAt);
  if (days === null) return "none";
  if (days < 0) return "expired";
  if (days <= EXPIRING_SOON_DAYS) return "soon";
  return "later";
}

/** The badge tone a group renders with. */
function warrantyExpiryTone(
  group: WarrantyExpiryGroup,
): "red" | "amber" | "gray" | "blue" {
  if (group === "expired") return "red";
  if (group === "soon") return "amber";
  if (group === "none") return "gray";
  return "blue";
}

/** Badge text + tone for a warranty, tolerating a null `today` (before
 * mount there is no local date to judge against, so the label names the date
 * instead of judging it, and the tone stays neutral). */
export function warrantyExpiryBadge(
  expiresAt: string,
  today: string | null,
): { tone: "red" | "amber" | "gray" | "blue"; label: string } {
  if (!today) {
    return {
      tone: "gray",
      label: expiresAt ? `Expires ${expiresAt}` : "No expiry",
    };
  }
  return {
    tone: warrantyExpiryTone(warrantyExpiryGroup(expiresAt, today)),
    label: warrantyExpiryLabel(expiresAt, today),
  };
}

/** The row badge text: "Expired 12 days ago", "Expires in 45 days", or
 * "Expires 2027-03-14" for a date past the soon window. */
export function warrantyExpiryLabel(expiresAt: string, today: string): string {
  const group = warrantyExpiryGroup(expiresAt, today);
  if (group === "none") return "No expiry";
  const days = daysBetween(today, expiresAt)!;
  if (group === "later") return `Expires ${expiresAt}`;
  if (group === "expired") {
    const ago = -days;
    return `Expired ${ago} ${ago === 1 ? "day" : "days"} ago`;
  }
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${days} days`;
}
