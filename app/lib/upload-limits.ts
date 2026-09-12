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
