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
    name: "main",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: [
      "test/default-categories.test.ts",
      "test/schedule-c.test.ts",
      "test/escape.test.ts",
      "test/file-types.test.ts",
      "test/validation.test.ts",
      "test/email-classify.test.ts",
      "test/email-corpus.test.ts",
      "test/llm-alert.test.ts",
      "test/email-mime.test.ts",
      "test/fx.test.ts",
      "test/format.test.ts",
      "test/duplicates.test.ts",
      "test/excel.test.ts",
      "test/statements.test.ts",
      "test/receipt-pdf.test.ts",
      "test/within-window.test.ts",
      "test/jmap-email-schema.test.ts",
      "test/llms-txt.test.ts",
      "test/expense-search.test.ts",
      "test/shortcut-anchors.test.ts",
    ],
    env: {
      DATABASE_URL: "postgres://assaf@localhost/expense_test",
      // Fixed key so connected-email-account tests can encrypt/decrypt
      // tokens (production value lives only in Vercel env).
      EMAIL_TOKEN_ENCRYPTION_KEY:
        "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      // Hermetic LLM config: receipt-ai tests stub fetch and capture the
      // request body. A distinct vision model proves the image path uses
      // the override; the DeepSeek base URL exercises the `thinking` param.
      LLM_API_KEY: "test-llm-key",
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_VISION_MODEL: "vision-test-model",
      // Dummy Gmail OAuth client so the google-oauth module treats the
      // deployment as configured in unit tests (routes that need it mock
      // the accessor; URL/resolver tests assert the real value).
      GOOGLE_OAUTH_CLIENT_ID: "test-gmail-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "test-gmail-client-secret",
      GOOGLE_PUBSUB_TOPIC: "projects/test/topics/expense-test",
      // Pinned empty so the push-webhook tests exercise the default
      // audience (derived from SITE_URL) even when a local .env carries a
      // real GOOGLE_PUBSUB_AUDIENCE for manual testing.
      GOOGLE_PUBSUB_AUDIENCE: "",
    },
    browser: { screenshotDirectory: "__screenshots__" },
    disableConsoleIntercept: !process.env.CI,
    execArgv: ["--max-old-space-size=3072"],
    fileParallelism: false,
    globalSetup: "test/helpers/globalSetup.ts",
    hookTimeout: 60_000,
    maxConcurrency: 1,
    maxWorkers: 1,
    pool: "forks",
    reporters: process.env.GITHUB_ACTIONS
      ? ["github-actions", "verbose"]
      : ["verbose"],
    setupFiles: "test/helpers/testSuiteSetup.ts",
    teardownTimeout: 5_000,
    testTimeout: 30_000,
  },
});
