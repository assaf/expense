import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Minimal vitest config for ad-hoc local runs that must NOT force-reset the
 * test database (the app's globalSetup runs `prisma db push --force-reset`).
 * Mirrors the `~` / prisma aliases from vite.config.ts and keeps the
 * per-file reseed (testSuiteSetup). Never used by CI or `pnpm test`.
 */
export default defineConfig({
  test: {
    env: {
      DATABASE_URL: "postgres://assaf@localhost/expense_test",
    },
    fileParallelism: false,
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    maxConcurrency: 1,
    maxWorkers: 1,
    pool: "forks",
    reporters: ["verbose"],
    setupFiles: "test/helpers/testSuiteSetup.ts",
    teardownTimeout: 5_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: [
      { find: "~", replacement: resolve("app") },
      { find: "~/test", replacement: resolve("test") },
      {
        find: "prisma/generated",
        replacement: resolve("prisma/generated/client"),
      },
      { find: "+types", replacement: resolve(".react-router/types") },
    ],
  },
});
