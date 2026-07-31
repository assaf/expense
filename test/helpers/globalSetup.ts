/**
 * Global setup: runs once before all test files.
 * Seeds test data and starts the forked test server.
 */
import { rm } from "node:fs/promises";
import { seedTestData } from "./seedTestData";
import { launchServer, closeServer } from "./launchServer";

export default async function setup() {
  // Ensure a fresh test data directory
  await rm("data-test", { recursive: true, force: true });
  await seedTestData();
  await launchServer();

  return teardown;
}

async function teardown() {
  await closeServer();
  await rm("data-test", { recursive: true, force: true }).catch(() => {});
}
