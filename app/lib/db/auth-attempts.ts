import { and, or } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { fromIso, fromIsoOrNull, toIso, toIsoOrNull } from "~/lib/db/wire";
import { isUniqueViolation } from "~/lib/db/pg-errors";

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
 * An already-active lock keeps its original expiry; a later failure while
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
  const row = await db.orm.public.AuthAttempt.first({ key });
  return row
    ? {
        failures: row.failures,
        windowStart: toIso(row.windowStart),
        lockedUntil: toIsoOrNull(row.lockedUntil),
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

/** Record one failed attempt; returns the new state (possibly locked).
 *
 * The write is a compare-and-swap, not a read-then-write: the UPDATE only
 * applies while the row still holds the state this call read (the same
 * failure count and window start), so two concurrent failures cannot both
 * write "failures + 1" and lose one. The old read-then-write lost those
 * increments, which made the lockout budget 5 x the concurrency, and let a
 * request that read the row BEFORE the lock landed overwrite the lock with
 * its stale state - erasing it.
 *
 * The policy is unchanged: nextFailureState still computes the new state
 * exactly as before, and it is still the one place the rule lives.
 */
export async function recordAuthFailure(
  key: string,
  options: AuthAttemptOptions = DEFAULT_OPTIONS,
  now: number = Date.now(),
): Promise<AuthAttemptState> {
  const state = await writeFailure(key, now, options);
  // Opportunistic sweep (best-effort, ~every 100th write): rows are only
  // ever deleted on a successful login, so without this an attacker can
  // grow auth_attempts unboundedly with unique keys (distinct emails or
  // rotated IPs). A row is dead when its window elapsed AND it is not
  // currently locking (nextFailureState would reset it anyway).
  //
  // The sweep window is the CALLER's (options.windowMs), not the auth
  // default: a caller passing a shorter window than the key family it is
  // sweeping could delete a row another caller's longer window still needs
  // (the counter would then restart early). Keep callers' windows at least
  // as long as AUTH_WINDOW_MS.
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
  return state;
}

/** Apply one failure to the key's row without losing a concurrent one.
 *
 * The write is a compare-and-swap, not a read-then-write: the UPDATE only
 * applies while the row still holds the state this call read (the same
 * failure count and window start), so two concurrent failures cannot both
 * write "failures + 1" and lose one. The old read-then-write lost those
 * increments, which made the lockout budget 5 x the concurrency, and let a
 * request that read the row BEFORE the lock landed overwrite the lock with
 * its stale state - erasing it. The swap closes the erasure, because such
 * a request's predicate (the old failure count) no longer matches the row
 * the lock wrote.
 *
 * The policy is unchanged: nextFailureState still computes the new state
 * exactly as before, and it is still the one place the rule lives.
 *
 * The residual: under a wave far wider than the retry budget, the writers
 * that keep losing the swap give up and their failure is not counted. The
 * complete fix is a single UPDATE that Postgres evaluates against the
 * stored row (the SQL builder's raw-expression lane - the idiom
 * bumpCounter uses in app/lib/email-connection-process.server.ts); that
 * needs the builder's raw-value typing settled first, so it is not in
 * this change.
 */
async function writeFailure(
  key: string,
  now: number,
  options: AuthAttemptOptions,
): Promise<AuthAttemptState> {
  const stamp = fromIso(new Date(now).toISOString());
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await readState(key);
    const next = nextFailureState(state, now, options);
    if (state === null) {
      // No row yet: create it. A concurrent create takes the unique key,
      // and the loop re-reads and updates THAT row instead.
      try {
        await db.orm.public.AuthAttempt.create({
          key,
          failures: next.failures,
          windowStart: fromIso(next.windowStart),
          lockedUntil: fromIsoOrNull(next.lockedUntil),
          updatedAt: stamp,
        });
        return next;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        continue;
      }
    }
    // The compare-and-swap: the update applies only while the row still
    // holds the state we read.
    const updated = await db.orm.public.AuthAttempt.where((r) =>
      and(
        r.key.eq(key),
        r.failures.eq(state.failures),
        r.windowStart.eq(fromIso(state.windowStart)),
      ),
    ).updateAll({
      failures: next.failures,
      windowStart: fromIso(next.windowStart),
      lockedUntil: fromIsoOrNull(next.lockedUntil),
      updatedAt: stamp,
    });
    if (updated.length > 0) return next;
    // Someone else wrote first: re-read and apply this failure on top of
    // their state.
  }
  // Contention past the retry budget: the caller's best-effort wrapper
  // logs and continues, exactly as a failed write does today.
  const state = await readState(key);
  return nextFailureState(state, now, options);
}

/** Writes between opportunistic sweeps of expired auth_attempts rows. */
const SWEEP_EVERY_WRITES = 100;
let writesSinceSweep = 0;

/** Delete rows whose window has fully elapsed and that are not currently
 * locking a key (lockedUntil in the future keeps the row; it is active).
 * Best-effort table hygiene: bounds storage growth from anonymous abuse. */
export async function sweepExpiredRows(
  now: number,
  windowMs: number,
): Promise<void> {
  const windowCutoff = new Date(now - windowMs).toISOString();
  const nowIso = new Date(now).toISOString();
  await db.orm.public.AuthAttempt.where((a) =>
    and(
      a.windowStart.lt(fromIso(windowCutoff)),
      or(a.lockedUntil.isNull(), a.lockedUntil.lt(fromIso(nowIso))),
    ),
  ).deleteAll();
}

/** Clear the key's failure state (called after a successful login/join). */
export async function clearAuthFailures(key: string): Promise<void> {
  await db.orm.public.AuthAttempt.where({ key }).deleteAll();
}
