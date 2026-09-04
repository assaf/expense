import { PUSH_AUTH, PUSH_PRIVATE_KEY } from "~/lib/env";
import { cronTick } from "~/lib/cron.server";
import { isTokenCryptoConfigured } from "~/lib/token-crypto.server";
import { ensureConnectionPushSubscription } from "~/lib/email-connection-push.server";
import { drainEmailConnection } from "~/lib/email-connection-process.server";
import { captureWarning } from "~/lib/errors.server";
import { connectionAccessToken } from "~/lib/fastmail-oauth.server";
import { ensureGmailWatch } from "~/lib/gmail.server";
import {
  listAllEmailConnections,
  setEmailConnectionStatus,
} from "~/lib/db/email-connections";
import type { Route } from "./+types/api.email-connections-cron";

/**
 * Daily maintenance cron for connected email accounts (vercel.json):
 * renew every connection's push setup and catch up on anything a missed
 * push left behind.
 *
 * - Fastmail (JMAP): subscriptions live ~30 days; recreate within 7 days
 *   of expiry; recreating triggers a fresh PushVerification our webhook
 *   completes.
 * - Gmail: watches expire after ~7 days; renew at a 48h margin, which
 *   gives the daily cron five chances before a lapse.
 *
 * A connection whose renewal fails (revoked token, provider error) is
 * flagged status=error so the user sees "Needs attention" in Settings.
 *
 * Auth, monitoring, and the response envelopes are the shared cronTick
 * helper (app/lib/cron.server.ts), same as /api/inbound-cron: Vercel cron
 * sends `Authorization: Bearer <CRON_SECRET>`; everything else is rejected.
 */

// Vercel: renewing many connections can exceed the 15s default.
export const config = { maxDuration: 60 };

// Gmail watch renewal margin: watches expire after ~7 days, so renewing
// at a 48h margin gives the daily cron five chances before a lapse.
const GMAIL_RENEW_MARGIN_MS = 48 * 60 * 60 * 1000;

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
        watchRenewed?: boolean;
        drained?: { evaluated: number; created: number };
        error?: string;
      }> = [];
      let failed = 0;

      for (const connection of connections) {
        // --- Renewal (provider-specific) -----------------------------
        try {
          if (connection.provider === "gmail") {
            const expiresMs = connection.pushExpiresAt
              ? Date.parse(connection.pushExpiresAt)
              : 0;
            let watchRenewed = false;
            if (expiresMs - GMAIL_RENEW_MARGIN_MS <= Date.now()) {
              const token = await connectionAccessToken(connection);
              await ensureGmailWatch(connection, token);
              watchRenewed = true;
            }
            results.push({ id: connection.id, watchRenewed });
          } else {
            const sub = await ensureConnectionPushSubscription(connection);
            results.push({
              id: connection.id,
              subscriptionId: sub.subscriptionId,
              created: sub.created,
            });
          }
          if (connection.status === "error") {
            await setEmailConnectionStatus(connection.id, "active");
          }
        } catch (err) {
          failed++;
          captureWarning("[email-connections-cron] renewal failed", {
            connectionId: connection.id,
            address: connection.emailAddress,
            error: err,
          });
          await setEmailConnectionStatus(connection.id, "error");
          results.push({ id: connection.id, error: String(err) });
          continue;
        }
        // --- Catch-up drain (provider-agnostic) ------------------------
        // Whatever a missed push left behind; logs + Sentry-captures on
        // failure: receipts silently stop importing for this connection
        // until the user notices the badge.
        try {
          const drain = await drainEmailConnection(connection);
          results[results.length - 1]!.drained = {
            evaluated: drain.evaluated,
            created: drain.created,
          };
        } catch (err) {
          captureWarning("[email-connections-cron] drain failed", {
            connectionId: connection.id,
            error: err,
          });
        }
      }

      return { total: connections.length, failed, results };
    },
  });
}
