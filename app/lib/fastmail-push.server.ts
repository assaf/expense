import { createECDH, randomBytes, type ECDH } from "node:crypto";
import { decrypt as eceDecrypt } from "http_ece";
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
 * FastMail push (RFC 8291 Web Push) support for the receipts-by-email
 * pipeline. Ported from the inbox project (lib/keys.ts, lib/decrypt.ts,
 * lib/subscription.ts).
 *
 * Decryption success is itself authentication on the push endpoint: only a
 * sender holding our public key can produce a decryptable payload. The
 * public key is derivable from PUSH_PRIVATE_KEY and is stored in the
 * Fastmail subscription — keep both env vars private.
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

export interface PushPayload {
  "@type": string;
  [key: string]: unknown;
}

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
  return JSON.parse(plain.toString("utf8")) as PushPayload;
}

/** Public push endpoint: `<PUBLIC_URL>/api/inbound-push`. */
export function pushUrl(): string {
  return `${PUBLIC_URL.replace(/\/+$/, "")}/api/inbound-push`;
}

const SUBSCRIPTION_LIFETIME_DAYS = 30;
const RENEW_WITHIN_DAYS = 7;

function ms(days: number): number {
  return days * 24 * 60 * 60 * 1000;
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

  const subs = await listSubscriptions();
  const ours = subs.filter((s) => s.deviceClientId === DEVICE_CLIENT_ID);

  for (const s of ours) {
    const expiring =
      !s.expires ||
      new Date(s.expires).getTime() < Date.now() + ms(RENEW_WITHIN_DAYS);
    if (expiring) {
      await destroySubscription(s.id);
    }
  }

  const remaining = (await listSubscriptions()).filter(
    (s) => s.deviceClientId === DEVICE_CLIENT_ID,
  );
  const live = remaining.find(
    (s) =>
      s.expires &&
      new Date(s.expires).getTime() >= Date.now() + ms(RENEW_WITHIN_DAYS),
  );
  if (live) return live.id;

  const expires = new Date(
    Date.now() + ms(SUBSCRIPTION_LIFETIME_DAYS),
  ).toISOString();
  const id = await createSubscription({
    url: pushUrl(),
    p256dh,
    auth,
    deviceClientId: DEVICE_CLIENT_ID,
    expires,
  });
  return id;
}
