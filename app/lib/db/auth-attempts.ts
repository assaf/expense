import prisma from "~/lib/prisma.server";

/**
 * Brute-force lockout state (Postgres `auth_attempts` table). Sign-in and
 * invite-code attempts are keyed per target ("login:<email>",
 * "invite:<code>") so a distributed attacker hammering one account trips
 * the lock regardless of where the requests come from. Pure decision logic
 * (`nextFailureState`, `isLocked`) is separated from the Prisma I/O so the
 * window/threshold rules are unit-testable without a database.
 */

/** Failures are counted within a rolling 15-minute window. */
export const AUTH_WINDOW_MS = 15 * 60_000;
/** Lock after this many failures inside the window. */
export const AUTH_THRESHOLD = 5;
/** A locked key stays locked this long (then the counter resets). */
export const AUTH_LOCK_MS = 15 * 60_000;

export interface AuthAttemptOptions {
  windowMs: number;
  threshold: number;
  lockMs: number;
}

const DEFAULT_OPTIONS: AuthAttemptOptions = {
  windowMs: AUTH_WINDOW_MS,
  threshold: AUTH_THRESHOLD,
  lockMs: AUTH_LOCK_MS,
};

/** The stored state for one key (shape of an `auth_attempts` row). */
export interface AuthAttemptState {
  failures: number;
  windowStart: string;
  lockedUntil: string | null;
}

/** True when the key is currently locked out (lockedUntil in the future). */
export function isLocked(state: AuthAttemptState | null, now: number): boolean {
  return (
    state !== null &&
    state.lockedUntil !== null &&
    Date.parse(state.lockedUntil) > now
  );
}

/** The state after one more failure: window-aware counter + threshold lock.
 * An already-active lock keeps its original expiry — a later failure while
 * locked does not extend it (the app rejects locked keys before recording
 * anyway, so this only matters for direct callers). */
export function nextFailureState(
  state: AuthAttemptState | null,
  now: number,
  options: AuthAttemptOptions = DEFAULT_OPTIONS,
): AuthAttemptState {
  const windowElapsed =
    state === null || now - Date.parse(state.windowStart) > options.windowMs;
  const failures = windowElapsed ? 1 : state!.failures + 1;
  if (isLocked(state, now)) {
    // Active lock: keep the expiry, update only the failure counter.
    return {
      failures,
      windowStart: windowElapsed
        ? new Date(now).toISOString()
        : state!.windowStart,
      lockedUntil: state!.lockedUntil,
    };
  }
  return {
    failures,
    windowStart: windowElapsed
      ? new Date(now).toISOString()
      : state!.windowStart,
    lockedUntil:
      failures >= options.threshold
        ? new Date(now + options.lockMs).toISOString()
        : null,
  };
}

/** The stored row for a key, or null. */
async function readState(key: string): Promise<AuthAttemptState | null> {
  const row = await prisma.authAttempt.findUnique({ where: { key } });
  return row
    ? {
        failures: row.failures,
        windowStart: row.windowStart,
        lockedUntil: row.lockedUntil,
      }
    : null;
}

/** The key's lockedUntil when it is currently locked, else null. */
export async function authLockedUntil(
  key: string,
  now: number = Date.now(),
): Promise<string | null> {
  const state = await readState(key);
  return isLocked(state, now) ? state!.lockedUntil : null;
}

/** Record one failed attempt; returns the new state (possibly locked). */
export async function recordAuthFailure(
  key: string,
  options: AuthAttemptOptions = DEFAULT_OPTIONS,
  now: number = Date.now(),
): Promise<AuthAttemptState> {
  const state = await readState(key);
  const next = nextFailureState(state, now, options);
  await prisma.authAttempt.upsert({
    where: { key },
    create: {
      key,
      failures: next.failures,
      windowStart: next.windowStart,
      lockedUntil: next.lockedUntil,
      updatedAt: new Date(now).toISOString(),
    },
    update: {
      failures: next.failures,
      windowStart: next.windowStart,
      lockedUntil: next.lockedUntil,
      updatedAt: new Date(now).toISOString(),
    },
  });
  // Opportunistic sweep (best-effort, ~every 100th write): rows are only
  // ever deleted on a successful login, so without this an attacker can
  // grow auth_attempts unboundedly with unique keys (distinct emails or
  // rotated IPs). A row is dead when its window elapsed AND it is not
  // currently locking — nextFailureState would reset it anyway.
  writesSinceSweep += 1;
  if (writesSinceSweep >= SWEEP_EVERY_WRITES) {
    writesSinceSweep = 0;
    try {
      await sweepExpiredRows(now, options.windowMs);
    } catch (err) {
      // Maintenance must never break the auth path.
      console.warn("[auth] auth_attempts sweep failed:", err);
    }
  }
  return next;
}

/** Writes between opportunistic sweeps of expired auth_attempts rows. */
const SWEEP_EVERY_WRITES = 100;
let writesSinceSweep = 0;

/** Delete rows whose window has fully elapsed and that are not currently
 * locking a key (lockedUntil in the future keeps the row — it is active).
 * Best-effort table hygiene: bounds storage growth from anonymous abuse. */
export async function sweepExpiredRows(
  now: number,
  windowMs: number,
): Promise<void> {
  const windowCutoff = new Date(now - windowMs).toISOString();
  const nowIso = new Date(now).toISOString();
  await prisma.authAttempt.deleteMany({
    where: {
      windowStart: { lt: windowCutoff },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: nowIso } }],
    },
  });
}

/** Clear the key's failure state (called after a successful login/join). */
export async function clearAuthFailures(key: string): Promise<void> {
  await prisma.authAttempt.deleteMany({ where: { key } });
}
