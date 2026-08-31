import { sentryOnBuildEnd } from "@sentry/react-router";
import type { Config } from "@react-router/dev/config";

export default {
  // File-based routing is enabled; pages are SSR'd for fast first paint.
  ssr: true,

  // The dev server sits behind a TLS-terminating proxy (https://
  // expense.localhost -> http://127.0.0.1), so the browser's Origin header
  // never matches the http origin the dev server sees. Without this, every
  // action POST (sign-in!) is rejected as CSRF with a 400.
  // Entries are bare hosts (they're matched against originUrl.host).
  allowedActionOrigins: ["expense.localhost"],

  prerender: async () => [],

  buildEnd: async ({ viteConfig, reactRouterConfig, buildManifest }) => {
    await sentryOnBuildEnd({
      viteConfig: viteConfig,
      reactRouterConfig: reactRouterConfig,
      buildManifest: buildManifest,
    });
  },
} satisfies Config;
