import * as Sentry from "@sentry/react-router";
import { browserTracingIntegration } from "@sentry/react";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// Sentry SDK init for the browser — production builds only, and only when
// VITE_SENTRY_DSN is configured at build time.
if (import.meta.env.PROD && import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN as string,
    environment: "production",
    integrations: [browserTracingIntegration()],
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
