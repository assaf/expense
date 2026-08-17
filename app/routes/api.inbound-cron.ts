import { CRON_SECRET, FASTMAIL_TOKEN } from "~/lib/env";
import { ensureSubscription } from "~/lib/fastmail-push.server";
import { processUnprocessedReceipts } from "~/lib/inbound-fastmail.server";
import { safeEqual } from "~/lib/passwords";
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
  const secret = CRON_SECRET;
  if (
    !secret ||
    !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const subscriptionId = await ensureSubscription();
    const result = await processUnprocessedReceipts();
    console.info("[inbound-cron] tick complete", {
      subscriptionId,
      ...result,
    });
    return Response.json({ ok: true, subscriptionId, ...result });
  } catch (err) {
    console.error("[inbound-cron] tick failed:", err);
    return Response.json({ error: "cron failed" }, { status: 500 });
  }
}
