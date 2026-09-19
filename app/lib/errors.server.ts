import * as Sentry from "@sentry/react-router";

/**
 * Log an error to the console and capture it in Sentry. Sentry is a no-op
 * until the server initializes it (app/entry.server.tsx, the bundled
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

/**
 * Log a warning and capture it in Sentry when initialized (no-op otherwise,
 * same contract as captureError). For recoverable failures the app absorbs
 * and keeps running, such as an outbound reply email that could not be sent
 * (the pipeline treats replies as fire-and-forget).
 */
export function captureWarning(
  message: string,
  extra?: Record<string, unknown>,
): void {
  console.warn(message, extra);
  if (Sentry.isInitialized()) {
    Sentry.captureMessage(message, { level: "warning", extra });
  }
}

/**
 * True for the errors React Router itself throws at bots and curious
 * humans: an unmatched URL, a missing loader, or a mutation aimed at a
 * route with no action. They are normal web traffic (a 404 or 405 answer),
 * not app failures, so the Sentry filter in app/entry.server.tsx drops
 * them. The action case is a bare POST to an index route's path: React
 * Router targets an index route's handler only through the `index` search
 * param, and the app's own fetchers always send it.
 */
export function isRouterNoise(error: {
  type?: unknown;
  value?: unknown;
}): boolean {
  const value = typeof error.value === "string" ? error.value : "";
  if (error.type === "NotFoundException" || value.includes("404")) return true;
  if (error.type !== "Error") return false;
  return (
    value.includes("No route matches URL") ||
    value.includes("did not provide a `loader`") ||
    value.includes("did not provide an `action`")
  );
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

/** User-presentable message from an unknown thrown value. The fallback
 * keeps internal error details out of UI responses when the throw is not
 * an Error (strings, objects); routes render the result verbatim. */
export function errorMessage(
  error: unknown,
  fallback = "Something went wrong",
): string {
  return error instanceof Error ? error.message : fallback;
}
