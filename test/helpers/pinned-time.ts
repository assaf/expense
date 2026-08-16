/**
 * Test-process clock pin. Installed by the vitest setup files
 * (testSuiteSetup.ts for the main project, frozen-time-setup.ts for the
 * unit project) so `new Date()` / `Date.now()` in the test process return
 * FROZEN_MS + real elapsed time since this module loaded (see frozen-time.ts
 * for the pinned instant and the three-clock model).
 *
 * The clock ticks in real time so timestamps stay distinct and monotonic
 * (orderBy createdAt works, webhook signatures stay within the server's
 * replay guard) while the calendar date is pinned to 2026-07-15 for any
 * realistic suite duration. Explicit dates and Date.parse/Date.UTC are
 * untouched; timers and performance.now() are never faked.
 */
import { FROZEN_MS } from "./frozen-time";

const RealDate = Date;
const REAL_START = RealDate.now();

class PinnedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) {
      super(FROZEN_MS + (RealDate.now() - REAL_START));
    } else {
      super(...(args as ConstructorParameters<typeof RealDate>));
    }
  }
  static now(): number {
    return FROZEN_MS + (RealDate.now() - REAL_START);
  }
}

/** Override globalThis.Date with the pinned ticking clock. */
export function installPinnedClock(): void {
  globalThis.Date = PinnedDate as unknown as DateConstructor;
}
