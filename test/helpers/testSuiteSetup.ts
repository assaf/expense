/**
 * Per-suite setup: runs before each test file.
 * Cleans test data and re-seeds it for isolation.
 */
import { rm } from "node:fs/promises";
import { afterAll, beforeAll } from "vite-plus/test";
import { seedTestData } from "./seedTestData";

beforeAll(async () => {
  await rm("data-test", { recursive: true, force: true }).catch(() => {});
  await seedTestData();
});

afterAll(async () => {
  if ("gc" in global && global.gc) global.gc();
});
