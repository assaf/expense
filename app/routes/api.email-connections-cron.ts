import { CRON_SECRET, PUSH_AUTH, PUSH_PRIVATE_KEY } from "~/lib/env";
import { isTokenCryptoConfigured } from "~/lib/token-crypto.server";
import { ensureConnectionPushSubscription } from "~/lib/email-connection-push.server";
import {
  listAllEmailConnections,
  setEmailConnectionStatus,
} from "~/lib/db/email-connections";
import { safeEqual } from "~/lib/passwords";
import type { Route } from "./+types/api.email-connections-cron";

/**
 * Daily maintenance cron for connected email accounts (vercel.json):
 * renew every connection's JMAP push subscription (they live ~30 days;
 * recreate within 7 days of expiry — recreating triggers a fresh
 * PushVerification our webhook completes). A connection whose renewal
 * fails (revoked token, FastMail error) is flagged status=error so the
 * user sees "Needs attention" in Settings.
 *
 * Same auth as /api/inbound-cron: Vercel cron sends
 * `Authorization: Bearer <CRON_SECRET>`; everything else is rejected.
 */

// Vercel: renewing many connections can exceed the 15s default.
export const config = { maxDuration: 60 };

export async function loader({ request }: Route.LoaderArgs) {
  const secret = CRON_SECRET;
  if (
    !secret ||
    !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!PUSH_PRIVATE_KEY || !PUSH_AUTH || !isTokenCryptoConfigured()) {
    return Response.json(
      {
        error:
          "Email account connections are not configured on this deployment",
      },
      { status: 503 },
    );
  }

  const connections = await listAllEmailConnections();
  const results: Array<{
    id: string;
    subscriptionId?: string;
    created?: boolean;
    error?: string;
  }> = [];
  let failed = 0;

  for (const connection of connections) {
    try {
      const sub = await ensureConnectionPushSubscription(connection);
      if (connection.status === "error") {
        await setEmailConnectionStatus(connection.id, "active");
      }
      results.push({
        id: connection.id,
        subscriptionId: sub.subscriptionId,
        created: sub.created,
      });
    } catch (err) {
      failed++;
      console.error("[email-connections-cron] renewal failed", {
        connectionId: connection.id,
        address: connection.emailAddress,
        err,
      });
      await setEmailConnectionStatus(connection.id, "error");
      results.push({ id: connection.id, error: String(err) });
    }
  }

  console.info("[email-connections-cron] tick complete", {
    total: connections.length,
    failed,
  });
  return Response.json({
    ok: true,
    total: connections.length,
    failed,
    results,
  });
}
