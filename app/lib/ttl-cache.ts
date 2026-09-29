/** Simple in-memory TTL cache. The read side gates with `isTest` to keep
 * tests deterministic; this helper only handles storage + expiry. It lives
 * outside `db/` so a module that must stay free of the database and the
 * environment (the JMAP client, the FX client) can cache too. */
export interface CacheStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
}

export function createCache<T>(ttlMs: number): CacheStore<T> {
  // Entries are keyed by accountId in a process that may serve many accounts,
  // so the map is bounded as well as TTL'd.
  const MAX_ENTRIES = 500;
  const map = new Map<string, { value: T; expiresAt: number }>();
  return {
    get(key) {
      const entry = map.get(key);
      if (entry && entry.expiresAt > Date.now()) return entry.value;
      // Drop the expired entry rather than leaving a dead key behind.
      if (entry) map.delete(key);
      return undefined;
    },
    set(key, value) {
      // Re-insert so insertion order stays "least recently written" for the
      // eviction below.
      map.delete(key);
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
      if (map.size > MAX_ENTRIES) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    delete(key) {
      map.delete(key);
    },
  };
}
