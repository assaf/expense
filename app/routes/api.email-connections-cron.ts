import { PUSH_AUTH, PUSH_PRIVATE_KEY } from "~/lib/env";
import { cronTick } from "~/lib/cron.server";
import { isTokenCryptoConfigured } from "~/lib/token-crypto.server";
import { ensureConnectionPushSubscription } from "~/lib/email-connection-push.server";
import { drainEmailConnection } from "~/lib/email-connection-process.server";
import { captureWarning } from "~/lib/errors.server";
import {
  listAllEmailConnections,
  setEmailConnectionStatus,
} from "~/lib/db/email-connections";
import type { Route } from "./+types/api.email-connections-cron";

/**
 * Daily maintenance cron for connected email accounts (vercel.json):
 * renew every connection's JMAP push subscription (they live ~30 days;
 * recreate within 7 days of expiry; recreating triggers a fresh
 * PushVerification our webhook completes). A connection whose renewal
 * fails (revoked token, FastMail error) is flagged status=error so the
 * user sees "Needs attention" in Settings.
 *
 * Auth, monitoring, and the response envelopes are the shared cronTick
 * helper (app/lib/cron.server.ts), same as /api/inbound-cron: Vercel cron
 * sends `Authorization: Bearer <CRON_SECRET>`; everything else is rejected.
 */

// Vercel: renewing many connections can exceed the 15s default.
export const config = { maxDuration: 60 };

export async function loader({ request }: Route.LoaderArgs) {
  return cronTick(request, {
    name: "email-connections-cron",
    crontab: "0 13 * * *",
    configured:
      Boolean(PUSH_PRIVATE_KEY && PUSH_AUTH) && isTokenCryptoConfigured(),
    configuredError:
      "Email account connections are not configured on this deployment",
    run: async () => {
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
            // Logged + Sentry-captured: receipts silently stop importing
            // for this connection until the user notices the badge.
            captureWarning("[email-connections-cron] drain failed", {
              connectionId: connection.id,
              error: err,
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
          captureWarning("[email-connections-cron] renewal failed", {
            connectionId: connection.id,
            address: connection.emailAddress,
            error: err,
          });
          await setEmailConnectionStatus(connection.id, "error");
          results.push({ id: connection.id, error: String(err) });
        }
      }

      return { total: connections.length, failed, results };
    },
  });
}
