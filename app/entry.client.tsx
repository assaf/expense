import * as Sentry from "@sentry/react-router";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// Sentry SDK init for the browser; production builds only, and only when
// VITE_SENTRY_DSN is configured at build time.
if (import.meta.env.PROD && import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN as string,
    environment: "production",
    // Same release the build uploaded sourcemaps for (injected at build
    // time by vite.config from VERCEL_GIT_COMMIT_SHA).
    release: (import.meta.env.VITE_SENTRY_RELEASE as string) || undefined,
    // The SDK's own integration for this framework: it wraps
    // browserTracingIntegration and instruments the hydrated router, which
    // plain browserTracingIntegration does not (the SDK warns on every page
    // load when handed the latter).
    integrations: [Sentry.reactRouterTracingIntegration()],
    tracesSampleRate: 0.2,
    // Browser errors are mostly ours; don't blow up the quota with noise.
    ignoreErrors: [
      // Browser extension / autofill noise (LastPass, Bitwarden, Chrome).
      /Object Not Found Matching Id:\d+/,
      /Request timeout for contentScriptVisibilityChanged/,
      /Script error\./,
    ],
  });
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter onError={Sentry.sentryOnError} />
    </StrictMode>,
  );
});
