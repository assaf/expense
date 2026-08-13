/**
 * Cross-cutting helpers shared by the `db/*` domain modules: the test-mode
 * flag, the in-memory TTL cache, and the email-verification TTL constants
 * used by both the account and the receipts-by-email sender flows.
 */

export const isTest =
  typeof process !== "undefined" && process.env.VITEST === "true";

/** Simple in-memory TTL cache. The read side gates with `isTest` to keep
 * tests deterministic — this helper only handles storage + expiry. */
export interface CacheStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
}

export function createCache<T>(ttlMs: number): CacheStore<T> {
  const map = new Map<string, { value: T; expiresAt: number }>();
  return {
    get(key) {
      const entry = map.get(key);
      if (entry && entry.expiresAt > Date.now()) return entry.value;
      return undefined;
    },
    set(key, value) {
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    delete(key) {
      map.delete(key);
    },
  };
}

/** Verification links (account signup + receipts-by-email sender) expire
 * 7 days after the email is sent. */
export const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Don't re-send a verification email for one address more than once a day. */
export const VERIFICATION_RESEND_MS = 24 * 60 * 60 * 1000;
