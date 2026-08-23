import {
  pushVerificationOf,
  readFastMailPush,
} from "~/lib/fastmail-push.server";
import { decryptSecret } from "~/lib/token-crypto.server";
import { setConnectionVerificationCode } from "~/lib/email-connection-push.server";
import {
  readEmailConnectionById,
  setEmailConnectionStatus,
  touchEmailConnectionPush,
} from "~/lib/db/email-connections";
import { drainEmailConnection } from "~/lib/email-connection-process.server";
import { badRequest } from "~/lib/validation";
import type { Route } from "./+types/api.email-connections-push";

/**
 * Webhook for CONNECTED email accounts (per-connection JMAP push). Same
 * scheme as /api/inbound-push: FastMail POSTs an RFC 8291-encrypted body,
 * and successful decryption with the app's push keys is the auth. The
 * connection arrives as `?c=<connectionId>` in the URL — its own API token
 * authenticates the JMAP side (verification echo, later mailbox reads).
 *
 *  - PushVerification: echo the code back with the connection's token so
 *    the subscription becomes verified.
 *  - StateChange: stamp lastPushAt. (Draining the inbox — matching emails
 *    and creating expenses — is the phase-3 pipeline; until it lands, this
 *    route only records that pushes flow.)
 *
 * The daily cron (/api/email-connections-cron) renews subscriptions and is
 * the catch-up net.
 */

// Vercel: the phase-3 processing pipeline will need the full budget.
export const config = { maxDuration: 60 };

export async function action({ request }: Route.ActionArgs) {
  const payload = await readFastMailPush(request, {
    logTag: "[email-connections-push]",
  });
  if (payload instanceof Response) return payload;

  // Checked after the shared preamble, so a request that fails either gate
  // gets that error first (previously `?c` was validated before the body).
  const connectionId = new URL(request.url).searchParams.get("c");
  if (!connectionId) return badRequest("missing connection");

  const connection = await readEmailConnectionById(connectionId);
  if (!connection) {
    // A disconnected (or stale) subscription still pushing — nothing to do.
    console.warn("[email-connections-push] unknown connection", {
      connectionId,
    });
    return Response.json({ error: "unknown connection" }, { status: 404 });
  }

  const type = payload["@type"];

  if (type === "PushVerification") {
    const { pushSubscriptionId: subscriptionId, verificationCode: code } =
      pushVerificationOf(payload) ?? {
        pushSubscriptionId: "",
        verificationCode: "",
      };
    try {
      const token = decryptSecret(connection.tokenEnc);
      await setConnectionVerificationCode(token, subscriptionId, code);
      if (connection.status === "error") {
        await setEmailConnectionStatus(connection.id, "active");
      }
      console.info("[email-connections-push] verified subscription", {
        connectionId,
        subscriptionId,
      });
    } catch (err) {
      console.error("[email-connections-push] verification update failed:", {
        connectionId,
        err,
      });
      return Response.json({ error: "verification failed" }, { status: 500 });
    }
  } else if (type === "StateChange") {
    try {
      await touchEmailConnectionPush(connection.id);
      console.info("[email-connections-push] state change", { connectionId });
      // Best effort — the daily cron is the catch-up net. A token revoked
      // between push and drain shows up here and flags the connection.
      try {
        const result = await drainEmailConnection(connection);
        console.info("[email-connections-push] drained", result);
      } catch (err) {
        console.error("[email-connections-push] drain failed:", {
          connectionId,
          err,
        });
        await setEmailConnectionStatus(connection.id, "error").catch(() => {});
      }
    } catch (err) {
      console.error("[email-connections-push] touch failed:", {
        connectionId,
        err,
      });
    }
  } else {
    console.warn("[email-connections-push] unknown payload type", {
      connectionId,
      type,
    });
  }

  return Response.json({ ok: true });
}
