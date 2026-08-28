import { toIso, toIsoOrNull } from "~/lib/db/wire";
import type { Account, User } from "~/lib/types";

/**
 * Cross-cutting helpers shared by the `db/*` domain modules: the test-mode
 * flag, the in-memory TTL cache, the email-verification TTL constants
 * used by both the account and the receipts-by-email sender flows, and the
 * Account/User row mappers every read path shares.
 */

/** Map an Account row to the domain shape (cache reads, invite lookups,
 * verified-sender lookups all map the same columns). */
export function accountFromRow(row: {
  id: string;
  name: string;
  inviteCode: string;
  createdAt: string;
}): Account {
  return {
    id: row.id,
    name: row.name,
    inviteCode: row.inviteCode,
    createdAt: toIso(row.createdAt),
  };
}

/** Map a User row to the domain User (the password hash and verification
 * token columns are deliberately never exposed). */
export function userFromRow(row: {
  id: string;
  accountId: string;
  email: string;
  emailVerifiedAt: string | null;
  createdAt: string;
}): User {
  return {
    id: row.id,
    accountId: row.accountId,
    email: row.email,
    emailVerifiedAt: toIsoOrNull(row.emailVerifiedAt),
    createdAt: toIso(row.createdAt),
  };
}

export const isTest =
  typeof process !== "undefined" && process.env.VITEST === "true";

/** Simple in-memory TTL cache. The read side gates with `isTest` to keep
 * tests deterministic; this helper only handles storage + expiry. */
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

/**
 * Read-through cache access: return the cached value when present, else run
 * `loader`, store, and return its result. Replaces the copy-pasted
 * `if (!isTest) { … get … } … set` choreography in the domain modules.
 *
 * An `undefined` loader result is deliberately NOT stored: a failed lookup
 * must keep querying until it succeeds (see findUserById / readAccount).
 */
export async function cachedRead<T>(
  cache: CacheStore<T>,
  key: string,
  loader: () => Promise<T>,
  { evenInTests = false }: { evenInTests?: boolean } = {},
): Promise<T> {
  if (!isTest || evenInTests) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
  }
  const value = await loader();
  if (value !== undefined) cache.set(key, value);
  return value;
}

/** Invalidate one cache entry. Pass a pending mutation to invalidate only
 * after it settles, passing its result through. This replaces the copy-pasted
 * `.then((r) => { cache.delete(key); return r; })` blocks. Like those
 * blocks, a rejected mutation leaves the stale entry in place. */
export function bust<T>(cache: CacheStore<T>, key: string): void;
export function bust<T, R>(
  cache: CacheStore<T>,
  key: string,
  mutation: Promise<R>,
): Promise<R>;
export function bust<T, R>(
  cache: CacheStore<T>,
  key: string,
  mutation?: Promise<R>,
): Promise<R> | void {
  if (mutation) {
    return mutation.then((r) => {
      cache.delete(key);
      return r;
    });
  }
  cache.delete(key);
}

/** Verification links (account signup + receipts-by-email sender) expire
 * 7 days after the email is sent. */
export const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Don't re-send a verification email for one address more than once a day. */
export const VERIFICATION_RESEND_MS = 24 * 60 * 60 * 1000;

/** True when `sentAt` is set and fresher than `window` (ms). Timestamps
 * arrive as TimestampString wire text ("2026-07-15 12:00:03.602", space
 * separator, no zone): toIso normalizes that to a UTC instant before the
 * comparison, since Date.parse would read it as local time. TTL expiry
 * checks read `!withinWindow(x, TTL)`; resend limits read
 * `withinWindow(x, RESEND)`, so the missing-timestamp polarity lives
 * here instead of in eight hand-rolled comparisons. */
export function withinWindow(
  sentAt: Date | string | null | undefined,
  window: number,
): boolean {
  if (!sentAt) return false;
  const sent =
    typeof sentAt === "string"
      ? Date.parse(sentAt.includes(" ") ? toIso(sentAt) : sentAt)
      : sentAt.getTime();
  return Number.isFinite(sent) && Date.now() - sent < window;
}
