import { PUSH_AUTH, PUSH_PRIVATE_KEY, PUBLIC_URL } from "~/lib/env";
import {
  ensurePushSubscription,
  p256dhFromPrivate,
} from "~/lib/fastmail-push.server";
import {
  jmapPushCreate,
  jmapPushDestroy,
  jmapPushList,
  jmapPushVerify,
} from "~/lib/jmap.server";
import { connectionAccessToken } from "~/lib/fastmail-oauth.server";
import { saveEmailConnectionSubscription } from "~/lib/db/email-connections";

/**
 * Per-connection JMAP push subscriptions (connected email accounts).
 *
 * Same RFC 8291 Web Push scheme as the app's own receipts pipeline
 * (fastmail-push.server.ts), with the SAME app-side keys
 * (PUSH_PRIVATE_KEY/PUSH_AUTH): they are our decryption keys, not
 * per-tenant secrets. What makes a subscription per-connection is the push
 * URL (carries the connection id) and the deviceClientId, so the daily cron
 * only ever touches its own subscription on the user's account.
 *
 * Every call authenticates as the user (their API token), unlike the
 * receipts pipeline which uses the app's global FASTMAIL_TOKEN. The JMAP
 * wire ops themselves live in jmap.server.ts; this module owns the
 * connection-specific plumbing (push URL, device id, persistence).
 */

/** Public webhook endpoint for one connection. */
function connectionPushUrl(connectionId: string): string {
  return `${PUBLIC_URL.replace(/\/+$/, "")}/api/email-connections-push?c=${connectionId}`;
}

/** Stable per-connection device id: `expense-conn-<connectionId>`. */
function connectionDeviceClientId(connectionId: string): string {
  return `expense-conn-${connectionId}`;
}

/** Echo Fastmail's PushVerification code back (completes the handshake). */
export async function setConnectionVerificationCode(
  token: string,
  subscriptionId: string,
  code: string,
): Promise<void> {
  return jmapPushVerify(token, subscriptionId, code);
}

export async function destroyConnectionPushSubscription(
  token: string,
  subscriptionId: string,
): Promise<void> {
  return jmapPushDestroy(token, subscriptionId);
}

export interface EnsureSubscriptionResult {
  subscriptionId: string;
  expires: string;
  created: boolean;
}

/**
 * Make sure a live subscription exists for a connection: destroy ours that
 * expired (or expire within the renew window), keep a live one, otherwise
 * create a fresh subscription. The new subscription triggers a
 * PushVerification push against our webhook, which completes the handshake
 * with the connection's own token.
 *
 * Persists the resulting id/expiry on the connection row so Settings and
 * the next cron tick can see the state.
 */
export async function ensureConnectionPushSubscription(connection: {
  id: string;
  tokenEnc: string;
}): Promise<EnsureSubscriptionResult> {
  if (!PUBLIC_URL) {
    throw new Error("PUBLIC_URL is required for Fastmail push");
  }
  const token = await connectionAccessToken(connection);
  const result = await ensurePushSubscription({
    url: connectionPushUrl(connection.id),
    deviceClientId: connectionDeviceClientId(connection.id),
    list: () => jmapPushList(token),
    destroy: (id) => jmapPushDestroy(token, id),
    create: (opts) =>
      jmapPushCreate(token, {
        ...opts,
        p256dh: p256dhFromPrivate(PUSH_PRIVATE_KEY),
        auth: PUSH_AUTH,
      }),
  });
  await saveEmailConnectionSubscription(
    connection.id,
    result.id,
    result.expires,
  );
  return {
    subscriptionId: result.id,
    expires: result.expires,
    created: result.created,
  };
}
