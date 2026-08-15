import { describe, expect, it } from "vitest";
import {
  AUTH_LOCK_MS,
  AUTH_THRESHOLD,
  AUTH_WINDOW_MS,
  isLocked,
  nextFailureState,
  type AuthAttemptState,
} from "~/lib/db/auth-attempts";

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
