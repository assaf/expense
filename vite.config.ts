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
      "test/fixtures/**",
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
      "test/fixtures/**",
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
        telemetry: false,
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
    projects: ["./vitest.unit.config.ts", "./vitest.main.config.ts"],
  },

  optimizeDeps: {
    // Never pre-bundle Node-only/native packages — the client never imports
    // them (server code is stripped from route bundles), and rolldown-vite's
    // optimizer chokes on their .node binaries (UNLOADABLE_DEPENDENCY).
    exclude: [
      "@sentry/react-router",
      "@napi-rs/canvas",
      "@resvg/resvg-js",
      "sharp",
      "tesseract.js",
      "pdfjs-dist",
      "@sparticuz/chromium",
      "puppeteer-core",
      "@sentry/profiling-node",
    ],
  },
}));
