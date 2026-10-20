import { describe, expect, it } from "vite-plus/test";
import prisma from "~/lib/prisma.server";
import { toIso, toIsoOrNull } from "~/lib/db/wire";
import {
  AUTH_LOCK_MS,
  AUTH_THRESHOLD,
  AUTH_WINDOW_MS,
  isLocked,
  nextFailureState,
  recordAuthFailure,
  sweepExpiredRows,
  type AuthAttemptState,
} from "~/lib/db/auth-attempts";
import {
  guardAnonymousAction,
  recordAnonymousAttempt,
} from "~/lib/auth.server";

/**
 * Window/threshold rules for the brute-force lockout (see auth-attempts.ts):
 * failures count inside a rolling window, the threshold trips a lock, and
 * an elapsed window resets the counter.
 */

const OPTIONS = {
  windowMs: AUTH_WINDOW_MS,
  threshold: AUTH_THRESHOLD,
  lockMs: AUTH_LOCK_MS,
};
const T0 = Date.parse("2026-01-01T00:00:00Z");

describe("nextFailureState", () => {
  it("counts failures inside the window without locking below the threshold", () => {
    let state: AuthAttemptState | null = null;
    for (let i = 1; i < AUTH_THRESHOLD; i += 1) {
      state = nextFailureState(state, T0 + i * 1_000, OPTIONS);
      expect(state!.failures).toBe(i);
      expect(state!.lockedUntil).toBeNull();
    }
  });

  it("locks at the threshold, and the lock expires after lockMs", () => {
    let state: AuthAttemptState | null = null;
    for (let i = 1; i <= AUTH_THRESHOLD; i += 1) {
      state = nextFailureState(state, T0 + i * 1_000, OPTIONS);
    }
    expect(state!.lockedUntil).not.toBeNull();
    expect(isLocked(state, T0 + 1_000)).toBe(true);
    expect(isLocked(state, Date.parse(state!.lockedUntil!) + 1)).toBe(false);
  });

  it("keeps the lock while locked, even on further failures", () => {
    let state: AuthAttemptState | null = null;
    for (let i = 1; i <= AUTH_THRESHOLD; i += 1) {
      state = nextFailureState(state, T0 + i * 1_000, OPTIONS);
    }
    const lockedUntil = state!.lockedUntil;
    // Further attempts inside the lock window keep the same expiry.
    for (let i = 1; i <= 3; i += 1) {
      state = nextFailureState(state, T0 + 10_000 * i, OPTIONS);
      expect(state!.lockedUntil).toBe(lockedUntil);
    }
  });

  it("resets the counter once the window has elapsed", () => {
    let state: AuthAttemptState | null = nextFailureState(null, T0, OPTIONS);
    state = nextFailureState(state, T0 + AUTH_WINDOW_MS + 1, OPTIONS);
    expect(state!.failures).toBe(1);
    expect(state!.windowStart).toBe(
      new Date(T0 + AUTH_WINDOW_MS + 1).toISOString(),
    );
  });

  it("starts fresh from a null state", () => {
    const state = nextFailureState(null, T0, OPTIONS);
    expect(state.failures).toBe(1);
    expect(state.lockedUntil).toBeNull();
  });
});

describe("isLocked", () => {
  it("is false for null state and for an expired lock", () => {
    expect(isLocked(null, T0)).toBe(false);
    const expired: AuthAttemptState = {
      failures: AUTH_THRESHOLD,
      windowStart: new Date(T0).toISOString(),
      lockedUntil: new Date(T0 - 1).toISOString(),
    };
    expect(isLocked(expired, T0)).toBe(false);
  });

  it("is true while the lock is active", () => {
    const active: AuthAttemptState = {
      failures: AUTH_THRESHOLD,
      windowStart: new Date(T0).toISOString(),
      lockedUntil: new Date(T0 + AUTH_LOCK_MS).toISOString(),
    };
    expect(isLocked(active, T0)).toBe(true);
  });
});

describe("anonymous-action per-IP throttle", () => {
  // A unique client IP per test keeps the counter isolated from parallel
  // files sharing the test database.
  function ipRequest(ip: string): Request {
    return new Request("http://expense.test/login", {
      headers: { "x-forwarded-for": ip },
    });
  }

  it("keeps the sign-in scope on its own budget (sign-in failures don't starve signup/join/resend)", async () => {
    const req = ipRequest("203.0.113.78");
    for (let i = 0; i < AUTH_THRESHOLD; i += 1) {
      await guardAnonymousAction(req, "signin");
      await recordAnonymousAttempt(req, "signin");
    }
    // The sign-in scope is exhausted…
    await expect(guardAnonymousAction(req, "signin")).rejects.toThrow(
      /too many failed attempts/i,
    );
    // …but the unscoped (signup/join/resend) budget for the same IP is
    // untouched: the two throttling domains must not share a counter.
    await expect(guardAnonymousAction(req)).resolves.toBeUndefined();
  });
});

async function countKey(key: string): Promise<number> {
  const { count } = await prisma.orm.public.AuthAttempt.where((a) =>
    a.key.eq(key),
  ).aggregate((agg) => ({ count: agg.count() }));
  return count;
}

describe("recordAuthFailure under concurrency", () => {
  it("counts every simultaneous failure and locks at the threshold", async () => {
    // The budget is 5 failures per 15 minutes. The old read-then-write
    // counter lost the increments: N simultaneous failures all read the
    // same count and the last writer won, so the lock needed N rounds
    // instead of one - and a request that read the row before the lock
    // landed could overwrite the lock with its stale state and erase it.
    const key = "race:threshold";
    const now = Date.parse("2026-03-01T00:00:00Z");
    try {
      await Promise.all(
        Array.from({ length: AUTH_THRESHOLD }, () =>
          recordAuthFailure(key, OPTIONS, now),
        ),
      );
      const row = await prisma.orm.public.AuthAttempt.first({ key });
      expect(row?.failures).toBe(AUTH_THRESHOLD);
      expect(row?.lockedUntil).not.toBeNull();
    } finally {
      await prisma.orm.public.AuthAttempt.where((a) =>
        a.key.eq(key),
      ).deleteAll();
    }
  });

  it("counts every simultaneous failure when no lock is in play", async () => {
    // Two callers would not prove the counter: they can serialize, and then
    // the old code produced 2 as well. Eight at once cannot.
    //
    // The count is exact: one statement, evaluated by Postgres against the
    // stored row, so every failure is counted and none is lost to a
    // concurrent writer.
    const key = "race:wide";
    const now = Date.parse("2026-03-02T00:00:00Z");
    try {
      await Promise.all(
        Array.from({ length: 8 }, () => recordAuthFailure(key, OPTIONS, now)),
      );
      const row = await prisma.orm.public.AuthAttempt.first({ key });
      expect(row?.failures).toBe(8);
      expect(row?.lockedUntil).not.toBeNull();
    } finally {
      await prisma.orm.public.AuthAttempt.where((a) =>
        a.key.eq(key),
      ).deleteAll();
    }
  });
});

describe("the SQL policy and the TypeScript policy agree", () => {
  it("writes the state nextFailureState computes, for every shape", async () => {
    // The counter's rule lives twice: the CASE expressions Postgres
    // evaluates, and nextFailureState. This walks the shapes and holds the
    // two to the same answer, so a change to one without the other fails
    // here.
    const key = "diff:policy";
    const now = Date.parse("2026-04-01T00:00:00Z");
    const read = async (): Promise<AuthAttemptState | null> => {
      const row = await prisma.orm.public.AuthAttempt.first({ key });
      return row
        ? {
            failures: row.failures,
            windowStart: toIso(row.windowStart),
            lockedUntil: toIsoOrNull(row.lockedUntil),
          }
        : null;
    };
    const cases: Array<{ label: string; failures: number; at: number }> = [
      { label: "no row yet", failures: 0, at: now },
      { label: "inside the window", failures: 3, at: now },
      { label: "at the threshold", failures: 4, at: now },
      { label: "an active lock", failures: 5, at: now },
      {
        label: "exactly one window old",
        failures: 2,
        at: now - OPTIONS.windowMs,
      },
      {
        label: "the window elapsed",
        failures: 2,
        at: now - OPTIONS.windowMs - 1,
      },
    ];
    try {
      for (const c of cases) {
        await prisma.orm.public.AuthAttempt.where((a) =>
          a.key.eq(key),
        ).deleteAll();
        for (let i = 0; i < c.failures; i += 1) {
          await recordAuthFailure(key, OPTIONS, c.at);
        }
        const expected = nextFailureState(await read(), now, OPTIONS);
        await recordAuthFailure(key, OPTIONS, now);
        expect(await read(), c.label).toEqual(expected);
      }
    } finally {
      await prisma.orm.public.AuthAttempt.where((a) =>
        a.key.eq(key),
      ).deleteAll();
    }
  });
});

describe("sweepExpiredRows", () => {
  const T0 = Date.parse("2026-02-01T00:00:00Z");
  const TEST_KEYS = ["sweep:stale", "sweep:locked", "sweep:fresh"];

  it("deletes elapsed-window rows but keeps fresh rows and active locks", async () => {
    // One failure at T0 (window starts, not locked)…
    await recordAuthFailure("sweep:stale", OPTIONS, T0);
    // Five failures at T0, locks until T0 + lockMs…
    for (let i = 0; i < AUTH_THRESHOLD; i += 1) {
      await recordAuthFailure("sweep:locked", OPTIONS, T0);
    }
    // A fresh failure just before the second sweep (its window is new).
    const T_FRESH = T0 + AUTH_WINDOW_MS;
    await recordAuthFailure("sweep:fresh", OPTIONS, T_FRESH);

    // Mid-window sweep (T0 + 1s): nothing is expired yet; stale's window
    // is 1s old, locked is still locking, fresh is brand new.
    await sweepExpiredRows(T0 + 1_000, AUTH_WINDOW_MS);
    for (const key of TEST_KEYS) {
      expect(await countKey(key)).toBe(1);
    }

    // Sweep one minute after the window elapsed for the T0 rows (T0 + 16min):
    // stale (elapsed, unlocked) and locked (its T0 + 15min lock has expired)
    // are swept; fresh (created at T0 + 15min, so 1 minute into its window)
    // is kept.
    await sweepExpiredRows(T0 + AUTH_WINDOW_MS + 60_000, AUTH_WINDOW_MS);
    expect(await countKey("sweep:stale")).toBe(0);
    expect(await countKey("sweep:locked")).toBe(0);
    expect(await countKey("sweep:fresh")).toBe(1);

    // Cleanup: never leave rows behind for other tests.
    await prisma.orm.public.AuthAttempt.where((a) =>
      a.key.in(TEST_KEYS),
    ).deleteAll();
  });
});
