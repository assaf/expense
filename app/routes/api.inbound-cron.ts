import * as Sentry from "@sentry/react-router";
import { FASTMAIL_TOKEN } from "~/lib/env";
import { ensureSubscription } from "~/lib/fastmail-push.server";
import { processUnprocessedReceipts } from "~/lib/inbound-fastmail.server";
import { assertCronSecret } from "~/lib/route-helpers.server";
import type { Route } from "./+types/api.inbound-cron";

/**
 * Daily FastMail maintenance + catch-up cron (vercel.json). Two jobs in one
 * tick:
 *  1. renew the push subscription when it is within 7 days of expiry
 *     (FastMail push subscriptions live ~30 days)
 *  2. drain the Receipts folder of anything a missed push left behind
 *
 * Vercel cron requests carry no built-in auth; the platform sends
 * `Authorization: Bearer <CRON_SECRET>` only when the env var is set, so the
 * route rejects everything else.
 */

// Vercel: processing a backlog can exceed the 15s default.
export const config = { maxDuration: 60 };

export async function loader({ request }: Route.LoaderArgs) {
  if (!FASTMAIL_TOKEN) {
    return Response.json(
      { error: "FastMail is not configured on this deployment" },
      { status: 503 },
    );
  }
  const denied = assertCronSecret(request);
  if (denied) return denied;

  try {
    // Sentry cron monitor: a missed check-in (cron stops firing, the drain
    // throws before completing, the route breaks on a bad deploy) alerts:
    // the watchdog for the receipts pipeline. No-op when Sentry isn't
    // initialized (dev/tests/previews), so the tick still runs everywhere.
    const runTick = async () => {
      const subscriptionId = await ensureSubscription();
      const result = await processUnprocessedReceipts();
      return { subscriptionId, ...result };
    };
    const result = Sentry.isInitialized()
      ? await Sentry.withMonitor("expense-inbound-cron", runTick, {
          schedule: { type: "crontab", value: "0 12 * * *" },
        })
      : await runTick();
    console.info("[inbound-cron] tick complete", {
      ...result,
    });
    return Response.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    console.error("[inbound-cron] tick failed:", err);
    return Response.json({ error: "cron failed" }, { status: 500 });
  }
}
