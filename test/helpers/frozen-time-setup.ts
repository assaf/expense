/**
 * Unit-project setup: pin the test-process clock to the suite-wide pinned
 * instant (see frozen-time.ts / pinned-time.ts). Date only — timers and
 * performance.now() stay real.
 */
import { installPinnedClock } from "./pinned-time";

installPinnedClock();
