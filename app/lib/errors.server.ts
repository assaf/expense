import * as Sentry from "@sentry/react-router";

import { redactCredentials, stableForGrouping } from "~/lib/error-text";

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
    const detail =
      extra?.error === undefined
        ? extra
        : { ...extra, errorSummary: errorSummary(extra.error) };
    Sentry.captureException(error, detail ? { extra: detail } : undefined);
  }
}

/**
 * Log a warning and capture it in Sentry when initialized (no-op otherwise,
 * same contract as captureError). For recoverable failures the app absorbs
 * and keeps running, such as an outbound reply email that could not be sent
 * (the pipeline treats replies as fire-and-forget).
 *
 * The summary goes in the MESSAGE as well as in `extra`, because `extra` is
 * the part Sentry's server-side scrubber is free to replace with
 * [Filtered]: EXPENSE-1B lost its message, stack and errorSummary that way
 * while a sibling issue's identical mechanism came through intact. The
 * message survives, so the diagnostic has to live there. Volatile ids are
 * collapsed first, so one failure mode stays one Sentry issue rather than
 * one per request.
 */
export function captureWarning(
  message: string,
  extra?: Record<string, unknown>,
): void {
  console.warn(message, extra);
  if (!Sentry.isInitialized()) return;
  const summary =
    extra?.error === undefined ? undefined : errorSummary(extra.error);
  Sentry.captureMessage(
    summary === undefined
      ? message
      : `${message} ${stableForGrouping(summary)}`,
    {
      level: "warning",
      extra:
        summary === undefined ? extra : { ...extra, errorSummary: summary },
    },
  );
}

/** How many `cause` links a summary follows. Deep enough for the wrappers this
 * app and its libraries build (our stage label -> the provider call -> undici
 * -> the socket), short enough that a cause cycle cannot run away. */
const CAUSE_DEPTH_LIMIT = 4;

/** One bounded line describing an unknown thrown value, with anything
 * credential-shaped masked. Safe to put in front of a reader (Sentry, a
 * reconnect email) where the raw message may be redacted or read by a human:
 * the error's class, the first line of its message, and then the same for each
 * `cause` behind it — and nothing else.
 *
 * The cause chain is load-bearing for anything that crosses the network. Node
 * reports every undici failure as `TypeError: fetch failed` and puts the
 * actual reason (a reset connection, a connect timeout, a DNS answer) on
 * `cause`, so a summary that stopped at the first line said "fetch failed" and
 * nothing whatsoever about why: three EXPENSE-1K events arrived that way, with
 * no way to tell a Fastmail outage from a blip in our egress. */
export function errorSummary(error: unknown, limit = 200): string {
  if (!(error instanceof Error)) return typeof error;
  const segments: string[] = [];
  for (
    let current: unknown = error, depth = 0;
    current instanceof Error && depth < CAUSE_DEPTH_LIMIT;
    current = current.cause, depth++
  ) {
    const first = (current.message.split("\n")[0] ?? "").trim();
    segments.push(
      first.length === 0 ? current.name : `${current.name}: ${first}`,
    );
  }
  // Masking runs on the input BEFORE the length cap, so the cap never bounds
  // the work the mask does: bound what goes in instead (the mask itself is
  // linear — see the perf case in test/errors.test.ts).
  const kept: string[] = [];
  for (const segment of segments) {
    const masked = redactCredentials(segment).replace(/\s+/g, " ");
    // A caller that built its message out of a shallower errorSummary already
    // carries the cause text — `drainStep` does exactly that, so the chain
    // arrived twice and the cap cut away the half that explained the failure.
    if (kept.some((earlier) => earlier.includes(masked))) continue;
    kept.push(masked);
  }
  // Split the budget only when there IS a chain to fit: truncating the tail
  // would drop the part that explains the failure, and truncating a lone
  // message the way this always has would be a silent behaviour change.
  const cap = kept.length > 1 ? Math.ceil(limit / 2) : limit;
  return kept
    .map((segment) => segment.slice(0, cap))
    .join(": ")
    .slice(0, limit);
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
