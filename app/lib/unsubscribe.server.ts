import { createHmac } from "node:crypto";
import { SESSION_SECRET } from "~/lib/env";
import { safeEqual } from "~/lib/passwords";

/**
 * Stateless signed tokens for marketing-email unsubscribe links
 * (https://belderbos.dev/blog/unsubscribe-without-login-django-signing/).
 *
 * The link in a marketing email must work with no login and no session, so
 * the URL itself is the credential: a token carrying the user id plus an
 * HMAC signature over it. Verifying the signature proves the token was
 * minted by this app; guessing another user's token requires SESSION_SECRET.
 * Nothing is stored: the link is permanent (a marketing-unsubscribe token
 * must never expire — an old email's link still does the one safe thing),
 * and unsubscribing is idempotent, so there is no spent-token state.
 *
 * Signing proves integrity, not secrecy: the user id is readable inside the
 * token, which is fine — it identifies whose subscription the link controls
 * and nothing else. Never extend this pattern to values that must stay
 * hidden from the recipient.
 *
 * Purpose scoping: the signing key is derived per purpose (the salt
 * argument), so a token minted for unsubscribing can never validate in
 * another flow that signs user ids. Add new purposes with their own salt.
 */

export const MARKETING_UNSUBSCRIBE_SALT = "marketing-unsubscribe";

function purposeKey(salt: string): Buffer {
  return createHmac("sha256", SESSION_SECRET)
    .update(`purpose:${salt}`)
    .digest();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign a value for one purpose: `payload.signature`, both base64url.
 * The payload is opaque to the verifier — it round-trips unchanged. */
export function signValue(value: string, salt: string): string {
  const payload = b64url(value);
  const signature = createHmac("sha256", purposeKey(salt))
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

/** Verify a signed token and return the original value, or null when the
 * token was tampered with, was minted for a different purpose, or is
 * malformed. Signature comparison is constant-time. */
export function verifySignedValue(token: string, salt: string): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = createHmac("sha256", purposeKey(salt))
    .update(payload)
    .digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    return Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/** The permanent unsubscribe token for a user's marketing emails. */
export function marketingUnsubscribeToken(userId: string): string {
  return signValue(userId, MARKETING_UNSUBSCRIBE_SALT);
}

/** Resolve a marketing-unsubscribe token to its user id, or null. */
export function marketingUnsubscribeUserId(token: string): string | null {
  return verifySignedValue(token, MARKETING_UNSUBSCRIBE_SALT);
}

/** The permanent unsubscribe URL for a user's marketing emails: the link
 * that goes in every marketing email's footer and List-Unsubscribe header. */
export function marketingUnsubscribeUrl(
  origin: string,
  userId: string,
): string {
  return `${origin}/unsubscribe/${marketingUnsubscribeToken(userId)}`;
}
