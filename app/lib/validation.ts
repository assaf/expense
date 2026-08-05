import { todayDate } from "~/lib/format";

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

/** Validate that a date string is YYYY-MM-DD and not in the future. */
export function validateDateNotFuture(date: string): string | null {
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Use a valid calendar date.";
  if (date > todayDate()) return "Date cannot be in the future.";
  return null;
}
