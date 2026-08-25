/**
 * Suite-wide pinned clock instant.
 *
 * The whole test suite runs on a pinned clock so that "today"-derived
 * assertions are deterministic regardless of the real wall clock. The instant
 * is 2026-07-15T12:00:00Z: noon UTC (same calendar date in every timezone
 * except the ±13/14 edges, and consistent between the test process and the
 * browser since both use the runner's timezone), inside the 2026 H2 IRS
 * mileage-rate period, and in the era of the seeded fixtures.
 *
 * All three clocks are pinned to this instant, ticking in real time from it
 * (FROZEN_MS + elapsed) so timestamps stay distinct and monotonic:
 *  - the test process: see pinned-time.ts (installPinnedClock, used by
 *    frozen-time-setup and testSuiteSetup),
 *  - the browser page (Playwright `page.clock.setFixedTime`): see
 *    launchBrowser's `freezePageClock` (fully frozen there; the browser never
 *    writes ordered timestamps),
 *  - the test server child process: see pinned-clock.mjs, loaded via
 *    NODE_OPTIONS in launchServer.
 *
 * Timers and `performance.now()` are NOT faked anywhere; only Date is
 * pinned, so polling loops and Playwright timeouts keep working.
 */
export const FROZEN_MS = Date.parse("2026-07-15T12:00:00.000Z");
