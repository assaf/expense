import * as Sentry from "@sentry/react-router";

/**
 * Log an error to the console and capture it in Sentry. Sentry is a no-op
 * until the server initializes it (app/entry.server.tsx — the bundled
 * module Vercel boots as the function handler; init runs only when
 * VERCEL_ENV=production, with the DSN from SENTRY_DSN or a hardcoded
 * fallback), so this is safe to call unconditionally from route error
 * handlers: `isInitialized()` is false in dev/tests/previews and capture is
 * skipped.
 */
export function captureError(
  error: unknown,
  extra?: Record<string, unknown>,
): void {
  console.error(error);
  if (Sentry.isInitialized()) {
    Sentry.captureException(error, extra ? { extra } : undefined);
  }
}

// Errors that are fatal during the initial SSR render surface twice: the
// render stream's onError fires, then renderToReadableStream rejects with
// the same error object and React Router forwards that rejection to
// handleError. Remember what was already reported so each error is captured
// exactly once, from whichever path sees it first.
const reportedErrors = new WeakSet<object>();

/**
 * Like captureError, but deduped by error identity: reporting the same error
 * object again (e.g. the stream onError and handleError for one fatal render
 * error) is a no-op. Use this from the SSR error paths.
 */
export function captureErrorOnce(
  error: unknown,
  extra?: Record<string, unknown>,
): void {
  if (typeof error === "object" && error !== null) {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }
  captureError(error, extra);
}
