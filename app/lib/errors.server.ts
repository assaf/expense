import * as Sentry from "@sentry/react-router";

/**
 * Log an error to the console and capture it in Sentry. Sentry is a no-op
 * until the server initializes it (instrument.server.mjs, loaded via
 * NODE_OPTIONS --import on Vercel production — the DSN is hardcoded there,
 * not in env), so this is safe to call unconditionally from route error
 * handlers: `isInitialized()` is false in dev/tests and capture is skipped.
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
