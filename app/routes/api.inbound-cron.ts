import { FASTMAIL_TOKEN } from "~/lib/env";
import { cronTick } from "~/lib/cron.server";
import { ensureSubscription } from "~/lib/fastmail-push.server";
import { processUnprocessedReceipts } from "~/lib/inbound-fastmail.server";
import type { Route } from "./+types/api.inbound-cron";

/**
 * Daily FastMail maintenance + catch-up cron (vercel.json). Two jobs in one
 * tick:
 *  1. renew the push subscription when it is within 7 days of expiry
 *     (FastMail push subscriptions live ~30 days)
 *  2. drain the Receipts folder of anything a missed push left behind
 *
 * Auth, monitoring, and the response envelopes are the shared cronTick
 * helper (app/lib/cron.server.ts): Vercel cron sends
 * `Authorization: Bearer <CRON_SECRET>`; everything else is rejected.
 */

// Vercel: processing a backlog can exceed the 15s default.
export const config = { maxDuration: 60 };

export async function loader({ request }: Route.LoaderArgs) {
  return cronTick(request, {
    name: "inbound-cron",
    crontab: "0 12 * * *",
    configured: Boolean(FASTMAIL_TOKEN),
    configuredError: "FastMail is not configured on this deployment",
    run: async () => {
      const subscriptionId = await ensureSubscription();
      const result = await processUnprocessedReceipts();
      return { subscriptionId, ...result };
    },
  });
}
