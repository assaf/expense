import { sentryOnBuildEnd } from "@sentry/react-router/vite";
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
    // sentryOnBuildEnd creates the release and uploads sourcemaps through
    // the sentry CLI, which needs SENTRY_AUTH_TOKEN. Mirror the init gate in
    // entry.server: production deploys only. Without it, a local or CI build
    // whose SENTRY_AUTH_TOKEN is unset (or a shell holding the "[SENSITIVE]"
    // placeholder that `vercel env pull` writes for Secret vars) runs the
    // CLI and logs a failure where v10 skipped silently.
    if (process.env.VERCEL_ENV !== "production") return;
    if (!process.env.SENTRY_AUTH_TOKEN) return;
    await sentryOnBuildEnd({
      viteConfig: viteConfig,
      reactRouterConfig: reactRouterConfig,
      buildManifest: buildManifest,
    });
  },
} satisfies Config;
