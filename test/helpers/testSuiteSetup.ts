/**
 * Per-suite setup: runs before each test file.
 * Re-seeds the test database for isolation.
 */
import { afterAll, beforeAll } from "vitest";
import { seedTestData } from "./seedTestData";
import { installPinnedClock } from "./pinned-time";

// Pin the test-process clock to the suite-wide pinned instant (see
// frozen-time.ts / pinned-time.ts). Ticking Date override — timers and
// performance.now() stay real, so polling loops and Playwright timeouts
// keep working while the calendar date is fixed.
installPinnedClock();

beforeAll(async () => {
  await seedTestData();
});

afterAll(async () => {
  if ("gc" in global && global.gc) global.gc();
});
