/**
 * Per-suite setup: runs before each test file.
 * Re-seeds the test database for isolation.
 */
import { afterAll, beforeAll } from "vitest";
import { seedTestData } from "./seedTestData";

beforeAll(async () => {
  await seedTestData();
});

afterAll(async () => {
  if ("gc" in global && global.gc) global.gc();
});
