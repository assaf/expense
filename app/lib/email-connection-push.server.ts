import { PUSH_AUTH, PUSH_PRIVATE_KEY, PUBLIC_URL } from "~/lib/env";
import { decryptSecret } from "~/lib/token-crypto.server";
import { jmapCall } from "~/lib/jmap.server";
import { p256dhFromPrivate } from "~/lib/fastmail-push.server";
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
 * receipts pipeline which uses the app's global FASTMAIL_TOKEN.
 */

const SUBSCRIPTION_LIFETIME_DAYS = 30;
const RENEW_WITHIN_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Public webhook endpoint for one connection. */
function connectionPushUrl(connectionId: string): string {
  return `${PUBLIC_URL.replace(/\/+$/, "")}/api/email-connections-push?c=${connectionId}`;
}

/** Stable per-connection device id: `expense-conn-<connectionId>`. */
function connectionDeviceClientId(connectionId: string): string {
  return `expense-conn-${connectionId}`;
}

interface ConnectionPushSubscription {
  id: string;
  deviceClientId: string;
  expires: string | null;
  url: string;
}

async function listConnectionPushSubscriptions(
  token: string,
): Promise<ConnectionPushSubscription[]> {
  const responses = await jmapCall(token, [["PushSubscription/get", {}, "m0"]]);
  const args = responses[0]![1] as { list?: ConnectionPushSubscription[] };
  return args.list ?? [];
}

async function createConnectionPushSubscription(
  token: string,
  opts: { url: string; deviceClientId: string; expires: string },
): Promise<string> {
  const responses = await jmapCall(token, [
    [
      "PushSubscription/set",
      {
        create: {
          sub1: {
            deviceClientId: opts.deviceClientId,
            url: opts.url,
            types: ["Email"],
            keys: {
              p256dh: p256dhFromPrivate(PUSH_PRIVATE_KEY),
              auth: PUSH_AUTH,
            },
            expires: opts.expires,
          },
        },
      },
      "m0",
    ],
  ]);
  const args = responses[0]![1] as {
    created?: Record<string, { id: string }>;
  };
  const id = args.created?.["sub1"]?.id;
  if (!id) throw new Error("PushSubscription/set created no subscription");
  return id;
}

/** Echo FastMail's PushVerification code back (completes the handshake). */
export async function setConnectionVerificationCode(
  token: string,
  subscriptionId: string,
  code: string,
): Promise<void> {
  await jmapCall(token, [
    [
      "PushSubscription/set",
      { update: { [subscriptionId]: { verificationCode: code } } },
      "m0",
    ],
  ]);
}

export async function destroyConnectionPushSubscription(
  token: string,
  subscriptionId: string,
): Promise<void> {
  await jmapCall(token, [
    ["PushSubscription/set", { destroy: [subscriptionId] }, "m0"],
  ]);
}

export interface EnsureSubscriptionResult {
  subscriptionId: string;
  expires: string;
  created: boolean;
}

/**
 * Make sure a live subscription exists for a connection: destroy ours that
 * expired (or expire within RENEW_WITHIN_DAYS), keep a live one, otherwise
 * create a fresh 30-day subscription. The new subscription triggers a
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
    throw new Error("PUBLIC_URL is required for FastMail push");
  }
  const token = decryptSecret(connection.tokenEnc);
  const deviceClientId = connectionDeviceClientId(connection.id);
  const notBefore = Date.now() + RENEW_WITHIN_DAYS * DAY_MS;

  const subs = await listConnectionPushSubscriptions(token);
  const ours = subs.filter((s) => s.deviceClientId === deviceClientId);

  for (const s of ours) {
    const expiring = !s.expires || new Date(s.expires).getTime() < notBefore;
    if (expiring) {
      await destroyConnectionPushSubscription(token, s.id);
    }
  }

  const live = ours.find(
    (s) => s.expires && new Date(s.expires).getTime() >= notBefore,
  );
  if (live?.expires) {
    await saveEmailConnectionSubscription(connection.id, live.id, live.expires);
    return { subscriptionId: live.id, expires: live.expires, created: false };
  }

  const expires = new Date(
    Date.now() + SUBSCRIPTION_LIFETIME_DAYS * DAY_MS,
  ).toISOString();
  const id = await createConnectionPushSubscription(token, {
    url: connectionPushUrl(connection.id),
    deviceClientId,
    expires,
  });
  await saveEmailConnectionSubscription(connection.id, id, expires);
  return { subscriptionId: id, expires, created: true };
}
