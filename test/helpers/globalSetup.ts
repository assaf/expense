/**
 * Global setup: runs once before all test files.
 * Recreates the test schema from Prisma (pnpm test:db:push → db push
 * --force-reset on expense_test), seeds the test database, and starts the
 * forked test server (Postgres only; images live in Postgres BYTEA).
 * Requires local Postgres (expense_test).
 */
import { execSync } from "node:child_process";
import { seedTestData, TEST_DB_URL } from "./seedTestData";
import { launchServer, closeServer } from "./launchServer";

export default async function setup() {
  process.env.DATABASE_URL = TEST_DB_URL;

  // Schema comes from prisma/schema.prisma: drop and recreate for a clean,
  // deterministic test database (expense_test is throwaway).
  execSync("pnpm test:db:push", {
    cwd: ".",
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
  });

  await seedTestData();
  await launchServer();

  return teardown;
}

async function teardown() {
  await closeServer();
}
