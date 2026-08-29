import * as Sentry from "@sentry/react-router";
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

  try {
    const runTick = async () => {
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

      return { total: connections.length, failed, results };
    };

    const result = await (Sentry.isInitialized()
      ? Sentry.withMonitor("expense-email-connections-cron", runTick, {
          schedule: { type: "crontab", value: "0 13 * * *" },
          // Vercel kills the lambda at maxDuration (60s); alert when a
          // tick outlives that window instead of the multi-hour default.
          // Margin absorbs Vercel cron lateness (observed ~25 min late on
          // 2026-08-29, well past the old 5-min margin, which logged a
          // false "missed" while the tick itself ran healthy).
          maxRuntime: 1,
          checkinMargin: 30,
        })
      : runTick());

    console.info("[email-connections-cron] tick complete", {
      total: result.total,
      failed: result.failed,
    });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[email-connections-cron] tick failed:", err);
    return Response.json({ error: "cron failed" }, { status: 500 });
  } finally {
    // Same flush requirement as /api/inbound-cron: the SDK's auto-flush is
    // Edge-only, so on Node serverless the ok check-in is dropped when the
    // lambda freezes after the response (the monitor would time out on
    // every run). Flush explicitly before returning.
    if (Sentry.isInitialized()) await Sentry.flush(3000);
  }
}
