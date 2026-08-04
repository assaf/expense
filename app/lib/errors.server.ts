import * as Sentry from "@sentry/react-router";

/**
 * Log an error to the console and capture it in Sentry. Sentry is a no-op
 * until the server initializes it (see entry.server.tsx — PROD + SENTRY_DSN),
 * so this is safe to call unconditionally from route error handlers.
 */
export function captureError(
  error: unknown,
  extra?: Record<string, unknown>,
): void {
  console.error(error);
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(error, extra ? { extra } : undefined);
  }
}
