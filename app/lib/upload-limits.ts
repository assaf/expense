/**
 * Receipt size caps, in bytes, in one place.
 *
 * The upload path (images.server.ts) and the inbound email path
 * (jmap.server.ts) must agree on one number: a receipt the editor refuses
 * to accept must not sneak in as an email attachment, and vice versa. Keep
 * this module dependency-free (no app imports) so the email side can import
 * it without dragging in env.ts and re-running its test network guard.
 */
export const MAX_RECEIPT_BYTES = 15_000_000;

/**
 * The same cap expressed as encoded characters: base64 emits 4 characters
 * per 3 bytes, so an argument longer than this cannot decode into an image
 * that fits. Exact on purpose, with no slack: padding lives inside the
 * 4-character groups.
 */
export const MAX_RECEIPT_ENCODED_CHARS = Math.floor(MAX_RECEIPT_BYTES / 3) * 4;

/**
 * Does a base64 argument carry more characters than `limit` encodes? Counts
 * the string in place, so an oversized argument is refused BEFORE anything
 * is allocated for it. Whitespace is skipped (MIME wraps at 76 columns and
 * decoders ignore it) and a `data:` URL prefix does not count, so a
 * legitimate image is never refused for how it was formatted.
 */
export function exceedsBase64Budget(text: string, limit: number): boolean {
  const start = text.startsWith("data:") ? text.indexOf(",") + 1 : 0;
  let count = 0;
  for (let i = start; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) continue;
    count += 1;
    if (count > limit) return true;
  }
  return false;
}
