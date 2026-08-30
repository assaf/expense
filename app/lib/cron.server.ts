import * as Sentry from "@sentry/react-router";

import { assertCronSecret } from "~/lib/route-helpers.server";

/**
 * Shared loader body for the Vercel cron routes (see vercel.json). Every
 * cron route has the same skeleton: secret gate, configured-deployment
 * gate, Sentry cron-monitor wrapping (or a plain run when Sentry is off,
 * as in dev/tests/previews), the ok/failed JSON envelopes, and the
 * explicit flush. The flush is load-bearing: the SDK's auto-flush only
 * works on the Edge runtime, so on Node serverless the ok check-in is
 * dropped when the lambda freezes after the response and every run times
 * out (docs/operations.md). Hand-rolling a cron route risks missing it.
 *
 * Auth comes before the configured check so an unauthenticated caller
 * learns nothing about the deployment's configuration.
 */

/** Vercel kills the lambda at the route's maxDuration; alert when a tick
 * outlives that window (maxRuntime in minutes) instead of the multi-hour
 * default. Margin absorbs Vercel cron lateness (observed ~25 min late on
 * 2026-08-29, well past the old 5-min margin, which logged a false
 * "missed" while the tick itself ran healthy). */
const CHECKIN_MARGIN_MINUTES = 30;
const MAX_RUNTIME_MINUTES = 1;

export async function cronTick(
  request: Request,
  options: {
    /** Monitor name and log tag (without the expense- prefix). */
    name: string;
    /** The vercel.json schedule, mirrored for the Sentry monitor. */
    crontab: string;
    /** Deployment is missing required env; the pipeline cannot run. */
    configured: boolean;
    configuredError: string;
    /** The actual tick. Runs inside the Sentry monitor when initialized. */
    run: () => Promise<Record<string, unknown>>;
  },
): Promise<Response> {
  const denied = assertCronSecret(request);
  if (denied) return denied;
  if (!options.configured) {
    return Response.json({ error: options.configuredError }, { status: 503 });
  }

  try {
    const runTick = async () => options.run();
    const result = await (Sentry.isInitialized()
      ? Sentry.withMonitor(`expense-${options.name}`, runTick, {
          schedule: { type: "crontab", value: options.crontab },
          maxRuntime: MAX_RUNTIME_MINUTES,
          checkinMargin: CHECKIN_MARGIN_MINUTES,
        })
      : runTick());
    console.info(`[${options.name}] tick complete`, result);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[${options.name}] tick failed:`, err);
    return Response.json({ error: "cron failed" }, { status: 500 });
  } finally {
    if (Sentry.isInitialized()) await Sentry.flush(3000);
  }
}
