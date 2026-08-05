import * as Sentry from "@sentry/react-router";
import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { captureErrorOnce } from "~/lib/errors.server";

// Sentry SDK init lives in instrument.server.mjs (loaded via NODE_OPTIONS
// --import in the start script, so it runs before this module). This entry
// only wires the request wrapper + error capture.

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
          // Client disconnect — nothing meaningful to report (handleError
          // skips aborted requests for the same reason).
          if (request.signal.aborted) return;
          // Report every render error — including ones thrown before the
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
 * shell failures). Capture in Sentry with the request context — this is how
 * production errors reach the dashboard; the console line keeps Vercel logs
 * readable too. captureErrorOnce dedupes the render errors already reported
 * via the stream's onError.
 */
export function handleError(error: unknown, { request }: { request: Request }) {
  if (request.signal.aborted) return;
  captureErrorOnce(error, { url: request.url, method: request.method });
}
export const instrumentations = [Sentry.createSentryServerInstrumentation()];
