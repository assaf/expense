/**
 * Server-process clock pin. Loaded via NODE_OPTIONS=--import by
 * test/helpers/launchServer.ts so the test server shares the suite-wide
 * pinned instant (test/helpers/frozen-time.ts; keep the instant in sync).
 *
 * `new Date()` and `Date.now()` return FROZEN_MS + real elapsed time since
 * this module loaded: the calendar date is pinned (2026-07-15 for any
 * realistic suite duration) while timestamps stay distinct and monotonic,
 * so `createdAt` ordering and relative TTLs behave exactly as in production.
 * Explicit dates (`new Date("...")`, `Date.parse`, `Date.UTC`) and real
 * timers / `performance.now()` are untouched.
 */
const FROZEN_MS = Date.parse("2026-07-15T12:00:00.000Z");
const RealDate = globalThis.Date;
const REAL_START = RealDate.now();

class PinnedDate extends RealDate {
  constructor(...args) {
    super(
      ...(args.length === 0
        ? [FROZEN_MS + (RealDate.now() - REAL_START)]
        : args),
    );
  }
  static now() {
    return FROZEN_MS + (RealDate.now() - REAL_START);
  }
}

globalThis.Date = PinnedDate;
