import { createECDH, randomBytes, type ECDH } from "node:crypto";
import { decrypt as eceDecrypt } from "http_ece";
import { z } from "zod";
import {
  DEVICE_CLIENT_ID,
  PUSH_AUTH,
  PUSH_PRIVATE_KEY,
  PUBLIC_URL,
} from "~/lib/env";
import {
  createSubscription,
  destroySubscription,
  listSubscriptions,
} from "~/lib/fastmail.server";

/**
 * Fastmail push (RFC 8291 Web Push) support for the receipts-by-email
 * pipeline. Ported from the inbox project (lib/keys.ts, lib/decrypt.ts,
 * lib/subscription.ts).
 *
 * Decryption success is itself authentication on the push endpoint: only a
 * sender holding our public key can produce a decryptable payload. The
 * public key is derivable from PUSH_PRIVATE_KEY and is stored in the
 * Fastmail subscription, so keep both env vars private.
 */

export function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export interface PushKeys {
  /** Private P-256 key, URL-safe base64 (no padding). */
  privateKey: string;
  /** 16-byte auth secret, URL-safe base64 (no padding). */
  auth: string;
  /** Uncompressed P-256 public point (65 bytes incl. 0x04), URL-safe base64. */
  p256dh: string;
}

export function generatePushKeys(): PushKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    privateKey: b64url(ecdh.getPrivateKey()),
    auth: b64url(randomBytes(16)),
    p256dh: b64url(ecdh.getPublicKey(undefined, "uncompressed")),
  };
}

/** Derive the public key from a stored private key, so only one value persists. */
export function p256dhFromPrivate(privateKey: string): string {
  const ecdh = ecdhFromPrivate(privateKey);
  return b64url(ecdh.getPublicKey(undefined, "uncompressed"));
}

export function ecdhFromPrivate(privateKey: string): ECDH {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
  return ecdh;
}

/** The decrypted push envelope. Decryption is the auth (only Fastmail
 * holds the key material), and the schema pins the event shape so a
 * changed payload is rejected loudly instead of silently no-oping the
 * drain. Extra event fields are kept (loose object). */
const pushPayloadSchema = z.looseObject({ "@type": z.string() });
export type PushPayload = z.infer<typeof pushPayloadSchema>;
/** Decrypt an RFC 8291 (aes128gcm) Web Push body from Fastmail. */
export function decryptPushBody(
  ciphertext: Buffer,
  privateKey: string,
  authSecret: string,
): PushPayload {
  const ecdh = ecdhFromPrivate(privateKey);
  const plain = eceDecrypt(ciphertext, {
    version: "aes128gcm",
    privateKey: ecdh,
    authSecret,
  });
  const parsed = pushPayloadSchema.safeParse(
    JSON.parse(plain.toString("utf8")),
  );
  if (!parsed.success) {
    throw new Error("push payload shape mismatch");
  }
  return parsed.data;
}

/** Public push endpoint: `<PUBLIC_URL>/api/inbound-push`. */
export function pushUrl(): string {
  return `${PUBLIC_URL.replace(/\/+$/, "")}/api/inbound-push`;
}

const MAX_BODY_BYTES = 1024 * 1024; // a push payload is a few KB

export interface FastmailPushOptions {
  /**
   * Extra env values this webhook additionally needs, e.g. FASTMAIL_TOKEN
   * on /api/inbound-push (the subscription renewal path uses it). Any unset
   * value makes the route bail with the not-configured 503.
   */
  requiredEnv?: Array<string | undefined>;
  /** Log context tag for the decrypt-failure warning, e.g. "[inbound-push]". */
  logTag: string;
}

/**
 * Shared preamble for the Fastmail JMAP push webhooks (public; decryption
 * success is itself the auth): config gate (503), method check (405),
 * body cap (413), then RFC 8291 decryption (400 on failure). Returns the
 * Response to bail with, or the decrypted payload.
 */
export async function readFastmailPush(
  request: Request,
  opts: FastmailPushOptions,
): Promise<Response | PushPayload> {
  if (!PUSH_PRIVATE_KEY || !PUSH_AUTH || opts.requiredEnv?.some((v) => !v)) {
    return Response.json(
      { error: "Fastmail push is not configured on this deployment" },
      { status: 503 },
    );
  }
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: "body too large" }, { status: 413 });
  }
  try {
    return decryptPushBody(body, PUSH_PRIVATE_KEY, PUSH_AUTH);
  } catch (err) {
    console.warn(`${opts.logTag} decrypt failed:`, err);
    return Response.json({ error: "decrypt failed" }, { status: 400 });
  }
}

export interface PushVerification {
  pushSubscriptionId: string;
  verificationCode: string;
}

const pushVerificationSchema = z.object({
  pushSubscriptionId: z.string(),
  verificationCode: z.string(),
});

/** Narrow the PushVerification fields out of a decrypted payload;
 * undefined when either field is missing or not a string. */
export function pushVerificationOf(
  payload: PushPayload,
): PushVerification | undefined {
  const parsed = pushVerificationSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

const SUBSCRIPTION_LIFETIME_DAYS = 30;
const RENEW_WITHIN_DAYS = 7;

function ms(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

/** What a push-ops adapter provides: list/create/destroy bound to one auth
 * flavor. The per-flavor plumbing (token, keys, endpoints) lives in the
 * closures; the renewal algorithm here is shared. */
export interface EnsurePushSubscriptionIo {
  list(): Promise<
    { id: string; deviceClientId: string; expires: string | null }[]
  >;
  create(opts: {
    url: string;
    deviceClientId: string;
    expires: string;
  }): Promise<string>;
  destroy(id: string): Promise<void>;
  url: string;
  deviceClientId: string;
}

/** The result of a renewal pass: the live subscription's id and expiry, and
 * whether this pass created it. */
export interface LivePushSubscription {
  id: string;
  expires: string;
  created: boolean;
}

/** The renewal algorithm both push flavors share: destroy our subscriptions
 * that expired (or expire within RENEW_WITHIN_DAYS), keep one live, else
 * create a fresh SUBSCRIPTION_LIFETIME_DAYS subscription. Lists fresh after
 * destroying, so a subscription another instance created in between is
 * kept, not duplicated. Recreating triggers a fresh PushVerification push
 * to the flavor's own webhook. */
export async function ensurePushSubscription(
  io: EnsurePushSubscriptionIo,
): Promise<LivePushSubscription> {
  const notBefore = Date.now() + ms(RENEW_WITHIN_DAYS);
  const ours = (await io.list()).filter(
    (s) => s.deviceClientId === io.deviceClientId,
  );
  for (const s of ours) {
    if (!s.expires || new Date(s.expires).getTime() < notBefore) {
      await io.destroy(s.id);
    }
  }
  const remaining = (await io.list()).filter(
    (s) => s.deviceClientId === io.deviceClientId,
  );
  const live = remaining.find(
    (s) => s.expires && new Date(s.expires).getTime() >= notBefore,
  );
  if (live?.expires) {
    return { id: live.id, expires: live.expires, created: false };
  }
  const expires = new Date(
    Date.now() + ms(SUBSCRIPTION_LIFETIME_DAYS),
  ).toISOString();
  const id = await io.create({
    url: io.url,
    deviceClientId: io.deviceClientId,
    expires,
  });
  return { id, expires, created: true };
}

/**
 * Make sure a live, verified subscription for our deviceClientId exists.
 * Self-heals an expired (or soon-expiring) subscription; recreating it
 * triggers a fresh PushVerification push to our own webhook.
 */
export async function ensureSubscription(): Promise<string> {
  if (!PUBLIC_URL) {
    throw new Error("PUBLIC_URL is required for Fastmail push");
  }
  const p256dh = p256dhFromPrivate(PUSH_PRIVATE_KEY);
  const auth = PUSH_AUTH;
  const { id } = await ensurePushSubscription({
    url: pushUrl(),
    deviceClientId: DEVICE_CLIENT_ID,
    list: () => listSubscriptions(),
    destroy: destroySubscription,
    create: (opts) => createSubscription({ ...opts, p256dh, auth }),
  });
  return id;
}
