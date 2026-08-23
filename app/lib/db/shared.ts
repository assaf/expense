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

/**
 * Read-through cache access: return the cached value when present, else run
 * `loader`, store, and return its result. Replaces the copy-pasted
 * `if (!isTest) { … get … } … set` choreography in the domain modules.
 *
 * An `undefined` loader result is deliberately NOT stored — a failed lookup
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
 * after it settles, passing its result through — replaces the copy-pasted
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
