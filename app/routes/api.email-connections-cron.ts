import { PUSH_AUTH, PUSH_PRIVATE_KEY } from "~/lib/env";
import { isTokenCryptoConfigured } from "~/lib/token-crypto.server";
import { ensureConnectionPushSubscription } from "~/lib/email-connection-push.server";
import { drainEmailConnection } from "~/lib/email-connection-process.server";
import {
  listAllEmailConnections,
  setEmailConnectionStatus,
} from "~/lib/db/email-connections";
import { assertCronSecret } from "~/lib/route-helpers.server";
import type { Route } from "./+types/api.email-connections-cron";

/**
 * Daily maintenance cron for connected email accounts (vercel.json):
 * renew every connection's JMAP push subscription (they live ~30 days;
 * recreate within 7 days of expiry; recreating triggers a fresh
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
  const denied = assertCronSecret(request);
  if (denied) return denied;
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
    drained?: { evaluated: number; created: number };
    error?: string;
  }> = [];
  let failed = 0;

  for (const connection of connections) {
    try {
      const sub = await ensureConnectionPushSubscription(connection);
      if (connection.status === "error") {
        await setEmailConnectionStatus(connection.id, "active");
      }
      // Catch-up drain for anything a missed push left behind.
      let drained: { evaluated: number; created: number } | undefined;
      try {
        const drain = await drainEmailConnection(connection);
        drained = { evaluated: drain.evaluated, created: drain.created };
      } catch (err) {
        console.error("[email-connections-cron] drain failed", {
          connectionId: connection.id,
          err,
        });
      }
      results.push({
        id: connection.id,
        subscriptionId: sub.subscriptionId,
        created: sub.created,
        drained,
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
