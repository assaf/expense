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
 * The write is one atomic statement; see writeFailure for why. */
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

/** Apply one failure to the key's row, atomically.
 *
 * ONE statement, and Postgres evaluates the whole policy against the
 * stored row: the failure count, the window reset and the threshold lock
 * all read the current values. Two concurrent failures therefore cannot
 * both write "failures + 1" and lose one, and a request that read the row
 * before a lock landed cannot overwrite the lock with a stale state.
 *
 * The ORM lane takes literals only, so this is the SQL builder with a raw
 * expression per column (the idiom bumpCounter uses in
 * app/lib/email-connection-process.server.ts). The parameters are cast:
 * the builder infers a text codec for a string, and the columns are
 * timestamps.
 *
 * The policy is written TWICE, and the two copies must move together:
 * nextFailureState (TypeScript) is the readable reference and the unit
 * tests' subject, and the CASE expressions above are the executable copy
 * Postgres evaluates. A change to the window rule or the threshold has to
 * land in both, or the update path and the create path disagree about what
 * the counter should be. test/auth-attempts.test.ts pins both against the
 * same states.
 */
async function writeFailure(
  key: string,
  now: number,
  options: AuthAttemptOptions,
): Promise<AuthAttemptState> {
  const nowIso = new Date(now).toISOString();
  const cutoffIso = new Date(now - options.windowMs).toISOString();
  const lockUntilIso = new Date(now + options.lockMs).toISOString();
  const threshold = options.threshold;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // The row is updated when it exists. A 0-row update means the key has
    // no row yet, so it is created below.
    const rows = await db.runtime().query(
      db.sql.public.auth_attempts
        .update((f, fns) => ({
          // An elapsed window resets the count to 1 and the window to now;
          // otherwise the count grows by one.
          failures:
            fns.raw`CASE WHEN ${f.windowStart} < ${cutoffIso}::timestamp THEN 1 ELSE ${f.failures} + 1 END`.returns(
              "pg/int4@1",
            ),
          windowStart:
            fns.raw`CASE WHEN ${f.windowStart} < ${cutoffIso}::timestamp THEN ${nowIso}::timestamp ELSE ${f.windowStart} END`.returns(
              "pg/timestamp-string@1",
            ),
          // An active lock keeps its own expiry; otherwise the new count
          // decides whether this failure locks the key.
          lockedUntil:
            fns.raw`CASE WHEN ${f.lockedUntil} > ${nowIso}::timestamp THEN ${f.lockedUntil} WHEN (CASE WHEN ${f.windowStart} < ${cutoffIso}::timestamp THEN 1 ELSE ${f.failures} + 1 END) >= ${threshold} THEN ${lockUntilIso}::timestamp ELSE NULL END`.returns(
              { codecId: "pg/timestamp-string@1", nullable: true },
            ),
          updatedAt: fns.raw`${nowIso}::timestamp`.returns(
            "pg/timestamp-string@1",
          ),
        }))
        .where((f, fns) => fns.eq(f.key, key))
        .returning("failures", "windowStart", "lockedUntil")
        .build(),
    );
    const row = rows[0];
    if (row) {
      return {
        failures: Number(row.failures),
        windowStart: toIso(row.windowStart),
        lockedUntil: toIsoOrNull(row.lockedUntil),
      };
    }
    // No row yet: create it. A concurrent create takes the unique key, and
    // the loop updates THAT row on the next pass.
    const first = nextFailureState(null, now, options);
    try {
      await db.orm.public.AuthAttempt.create({
        key,
        failures: first.failures,
        windowStart: fromIso(first.windowStart),
        lockedUntil: fromIsoOrNull(first.lockedUntil),
        updatedAt: fromIso(nowIso),
      });
      return first;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
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
