import { sentryReactRouter } from "@sentry/react-router";
import { resolve } from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig((config) => ({
  staged: {
    "*": "vp check --fix",
  },

  fmt: {
    ignorePatterns: [
      ".react-router/**",
      "build/**",
      "node_modules/**",
      "data-test/**",
      "prisma/generated/**",
    ],
    printWidth: 80,
    tabWidth: 2,
    singleQuote: false,
    semi: true,
  },

  lint: {
    ignorePatterns: [
      ".react-router/**",
      "build/**",
      "node_modules/**",
      "data-test/**",
      "prisma/generated/**",
      // tsgolint overflows on vite config generics; tsc checks it cleanly.
      "vite.config.ts",
    ],
    options: {
      reportUnusedDisableDirectives: "warn",
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "no-console": ["error", { allow: ["assert", "error", "info", "warn"] }],
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error",
      "react/no-danger": "error",
      "typescript/no-explicit-any": "warn",
      "typescript/no-unsafe-declaration-merging": "error",
      "unicorn/no-array-for-each": "warn",
      "unicorn/prefer-array-flat-map": "error",
    },
  },

  plugins: [
    tailwindcss(),
    reactRouter(),
    sentryReactRouter(
      {
        org: "labnotes",
        project: "expense",
        authToken: process.env.SENTRY_AUTH_TOKEN,
      },
      config,
    ),
  ],

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
    browser: { screenshotDirectory: "__screenshots__" },
    disableConsoleIntercept: !process.env.CI,
    env: {
      DATABASE_URL: "postgres://assaf@localhost/expense_test",
    },
    execArgv: ["--max-old-space-size=3072"],
    fileParallelism: false,
    globalSetup: "test/helpers/globalSetup.ts",
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
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

  optimizeDeps: {
    exclude: ["@sentry/react-router"],
  },
}));
