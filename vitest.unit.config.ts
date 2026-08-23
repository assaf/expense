import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
  test: {
    name: "unit",
    include: [
      "test/default-categories.test.ts",
      "test/escape.test.ts",
      "test/file-types.test.ts",
      "test/excel.test.ts",
      "test/validation.test.ts",
      "test/statements.test.ts",
      "test/receipt-pdf.test.ts",
      "test/email-classify.test.ts",
      "test/email-mime.test.ts",
      "test/format.test.ts",
      "test/duplicates.test.ts",
    ],
    env: {
      DATABASE_URL: "postgres://assaf@localhost/expense_test",
    },
    pool: "threads",
    fileParallelism: true,
    setupFiles: "test/helpers/frozen-time-setup.ts",
    testTimeout: 10_000,
    reporters: process.env.GITHUB_ACTIONS
      ? ["github-actions", "verbose"]
      : ["verbose"],
  },
});
