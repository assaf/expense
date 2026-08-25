import * as Sentry from "@sentry/react-router";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { captureErrorOnce } from "~/lib/errors.server";

// Sentry SDK init for the server runtime. This module is bundled into
// build/server/index.js, the exact file Vercel boots as the serverless
// function handler (the @vercel/remix-builder SSR template), so init runs
// in the deployed bundle. It must NOT live in a separate instrument file
// loaded via NODE_OPTIONS --import: Vercel never runs the `start` script
// (the function config has an empty environment), so that code never
// executed in production; server errors only ever reached Sentry locally.
// Gate on VERCEL_ENV=production so local dev/test and preview deployments
// don't emit to the production project. try/catch: if the profiling native
// module fails to load in some runtime, the app must still boot.
if (process.env.VERCEL_ENV === "production") {
  try {
    Sentry.init({
      dsn:
        process.env.SENTRY_DSN ??
        "https://c5f9e74db2e043db855cecb9eba20fcb@o510761.ingest.us.sentry.io/4511850854940672",
      // Matches the release the build created (sourcemaps, release health).
      release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,

      dataCollection: {
        // To disable sending user data and HTTP bodies, uncomment the lines below:
        // userInfo: false,
        // httpBodies: [],
      },

      // Enable logs to be sent to Sentry
      enableLogs: true,

      integrations: [nodeProfilingIntegration()],
      tracesSampleRate: 1.0, // Capture 100% of the transactions
      profilesSampleRate: 1.0, // profile every transaction

      // Filter out 404s and routing errors from error reporting.
      // React Router throws getInternalRouterError for unmatched routes
      // ("No route matches URL") and missing loaders ("did not provide
      // a `loader`"); these aren't app bugs, just normal web traffic.
      beforeSend(event) {
        if (event.exception) {
          const error = event.exception.values?.[0];
          if (
            error?.type === "NotFoundException" ||
            error?.value?.includes("404")
          ) {
            return null;
          }
          // getInternalRouterError for unmatched routes and missing
          // loaders: bots/crawlers/curious humans hitting paths that
          // don't exist or only support POST.
          if (error?.type === "Error") {
            const msg = error?.value ?? "";
            if (
              msg.includes("No route matches URL") ||
              msg.includes("did not provide a `loader`")
            ) {
              return null;
            }
          }
        }
        return event;
      },
    });
  } catch (error) {
    console.error("[sentry] init failed:", error);
  }
}

export default Sentry.wrapSentryHandleRequest(
  async (
    request: Request,
    responseStatusCode: number,
    responseHeaders: Headers,
    routerContext: EntryContext,
  ) => {
    const userAgent = request.headers.get("user-agent");

    const body = await renderToReadableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        signal: AbortSignal.timeout(10_000),
        onError(error: unknown) {
          responseStatusCode = 500;
          // Client disconnect; nothing meaningful to report (handleError
          // skips aborted requests for the same reason).
          if (request.signal.aborted) return;
          // Report every render error, including ones thrown before the
          // shell completes. The old shellRendered guard dropped those:
          // the response was a 500 but neither Vercel logs nor Sentry saw
          // the error. captureErrorOnce dedupes the fatal ones, which also
          // reject the stream and surface again via handleError.
          captureErrorOnce(error, { url: request.url });
        },
      },
    );

    if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
      await body.allReady;
    }

    responseHeaders.set("Content-Type", "text/html");
    return new Response(body, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  },
);

/**
 * Called by React Router for errors thrown in loaders and actions (server
 * and .data requests) and for render errors that rejected the stream (fatal
 * shell failures). Capture in Sentry with the request context; this is how
 * production errors reach the dashboard; the console line keeps Vercel logs
 * readable too. captureErrorOnce dedupes the render errors already reported
 * via the stream's onError.
 */
export function handleError(error: unknown, { request }: { request: Request }) {
  if (request.signal.aborted) return;
  captureErrorOnce(error, { url: request.url, method: request.method });
}
export const instrumentations = [Sentry.createSentryServerInstrumentation()];
