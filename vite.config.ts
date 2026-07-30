import { resolve } from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [
      ".react-router/**",
      "build/**",
      "node_modules/**",
      "data/**",
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
      "data/**",
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
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    alias: [
      { find: "~", replacement: resolve("app") },
      { find: "+types", replacement: resolve(".react-router/types") },
    ],
  },
});
