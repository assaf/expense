import { describe, expect, it } from "vitest";
import prisma from "~/lib/prisma.server";
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
    // untouched — the two throttling domains must not share a counter.
    await expect(guardAnonymousAction(req)).resolves.toBeUndefined();
  });
});

async function countKey(key: string): Promise<number> {
  return prisma.authAttempt.count({ where: { key } });
}

describe("sweepExpiredRows", () => {
  const T0 = Date.parse("2026-02-01T00:00:00Z");
  const TEST_KEYS = ["sweep:stale", "sweep:locked", "sweep:fresh"];

  it("deletes elapsed-window rows but keeps fresh rows and active locks", async () => {
    // One failure at T0 (window starts, not locked)…
    await recordAuthFailure("sweep:stale", OPTIONS, T0);
    // Five failures at T0 — locks until T0 + lockMs…
    for (let i = 0; i < AUTH_THRESHOLD; i += 1) {
      await recordAuthFailure("sweep:locked", OPTIONS, T0);
    }
    // A fresh failure just before the second sweep (its window is new).
    const T_FRESH = T0 + AUTH_WINDOW_MS;
    await recordAuthFailure("sweep:fresh", OPTIONS, T_FRESH);

    // Mid-window sweep (T0 + 1s): nothing is expired yet — stale's window
    // is 1s old, locked is still locking, fresh is brand new.
    await sweepExpiredRows(T0 + 1_000, AUTH_WINDOW_MS);
    for (const key of TEST_KEYS) {
      expect(await countKey(key)).toBe(1);
    }

    // Sweep one minute after the window elapsed for the T0 rows (T0 + 16min):
    // stale (elapsed, unlocked) and locked (its T0 + 15min lock has expired)
    // are swept; fresh — created at T0 + 15min, so 1 minute into its window
    // — is kept.
    await sweepExpiredRows(T0 + AUTH_WINDOW_MS + 60_000, AUTH_WINDOW_MS);
    expect(await countKey("sweep:stale")).toBe(0);
    expect(await countKey("sweep:locked")).toBe(0);
    expect(await countKey("sweep:fresh")).toBe(1);

    // Cleanup — never leave rows behind for other tests.
    await prisma.authAttempt.deleteMany({
      where: { key: { in: TEST_KEYS } },
    });
  });
});
