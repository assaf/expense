import { todayDate } from "~/lib/format";

/** Longest accepted password (both the signup validator and the login form
 * cap at this). Bounds the scrypt work an attacker can force with one
 * request — a megabyte-long password would otherwise trigger an expensive
 * derivation per attempt (see also the brute-force lockout in auth.server). */
export const MAX_PASSWORD_LENGTH = 128;

/** Sanitize a free-text name into a filesystem-safe token (spaces → _). */
export function sanitizeFilenamePart(input: string): string {
  return input
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Read a FormData field as a string (files become ""). */
export function formString(form: FormData, key: string): string {
  const v = form.get(key);
  return v instanceof File ? "" : (v ?? "");
}

/** Standard 400 response for an unrecognized form action intent. */
export function unknownIntent(): Response {
  return Response.json({ error: "Unknown intent." }, { status: 400 });
}

/**
 * Pragmatic email check: non-empty local part, @, dotted domain, no spaces.
 * Not RFC-complete (no IDN/quoting rules) — good enough to keep typos and
 * junk out of the login identity, which is all this app needs.
 */
export function isEmail(input: string): boolean {
  const email = input.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/** "Name <a@b.com>" → "a@b.com" (trimmed, lowercased). Shared by the inbound
 * pipeline (From address) and the sender store (storage/lookup keys). */
export function extractEmailAddress(addr: string): string {
  const m = addr.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  const candidate = m ? m[1]! : addr;
  return candidate.trim().toLowerCase();
}

/** Validate that a date string is YYYY-MM-DD. Future dates are allowed —
 * an invoice received today can be dated for a payment due next week. */
export function validateDate(date: string): string | null {
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Use a valid calendar date.";
  return null;
}

/** Validate that a date string is YYYY-MM-DD and not in the future. Used by
 * reconciliation, where statement transactions are always past-dated.
 * The ceiling is the CLIENT's local today (the browser knows its own
 * timezone; the server runs UTC — see the reconcile flow, which sends its
 * local date with the complete request). Falls back to the process offset
 * when the caller passes none (e.g. MCP, where UTC is the honest ceiling). */
export function validateDateNotFuture(
  date: string,
  today?: string,
): string | null {
  const error = validateDate(date);
  if (error) return error;
  // Trust only a well-formed client-supplied ceiling.
  const ceiling =
    today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : todayDate();
  if (date > ceiling) return "Date cannot be in the future.";
  return null;
}
