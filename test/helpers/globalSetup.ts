/**
 * Global setup: runs once before all test files.
 * Ensures the test schema exists, seeds the test database, and starts the
 * forked test server (which runs against Postgres + MinIO, matching prod).
 * Requires local Postgres (expensify_test) and MinIO (`docker compose up -d`).
 */
import { seedTestData } from "./seedTestData";
import { launchServer, closeServer } from "./launchServer";

export default async function setup() {
  // Select the Postgres backend before the app modules load, then ensure the
  // schema exists (the server process reuses the same database).
  process.env.DATABASE_URL = "postgres://localhost/expensify_test";
  const store = await import("~/lib/store.server");
  await store.initStore();
  await seedTestData();
  await launchServer();

  return teardown;
}

async function teardown() {
  await closeServer();
}
