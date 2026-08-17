import { createECDH } from "node:crypto";
import { encrypt } from "http_ece";
import { describe, expect, it } from "vitest";
import {
  b64url,
  decryptPushBody,
  ecdhFromPrivate,
  generatePushKeys,
  p256dhFromPrivate,
} from "~/lib/fastmail-push.server";

describe("push keys", () => {
  it("generates URL-safe base64 keys", () => {
    const keys = generatePushKeys();
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keys.auth).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keys.p256dh).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("p256dh is the uncompressed P-256 point (65 bytes = 87 base64url chars)", () => {
    const keys = generatePushKeys();
    expect(keys.p256dh).toHaveLength(87);
    expect(Buffer.from(keys.p256dh, "base64url")).toHaveLength(65);
    expect(Buffer.from(keys.p256dh, "base64url")[0]).toBe(0x04);
  });

  it("auth secret is 16 random bytes", () => {
    expect(Buffer.from(generatePushKeys().auth, "base64url")).toHaveLength(16);
  });

  it("derives the public point from the private key deterministically", () => {
    const keys = generatePushKeys();
    expect(p256dhFromPrivate(keys.privateKey)).toBe(keys.p256dh);
  });

  it("ecdhFromPrivate exposes the same public key", () => {
    const keys = generatePushKeys();
    const ecdh = ecdhFromPrivate(keys.privateKey);
    expect(ecdh.getPublicKey(undefined, "uncompressed")).toEqual(
      Buffer.from(keys.p256dh, "base64url"),
    );
  });

  it("b64url strips padding", () => {
    expect(b64url(Buffer.alloc(16))).not.toContain("=");
  });
});

describe("decryptPushBody", () => {
  it("round-trips an RFC 8291 aes128gcm payload", () => {
    const keys = generatePushKeys();
    const sender = createECDH("prime256v1");
    sender.generateKeys();

    const payload = {
      "@type": "PushVerification",
      pushSubscriptionId: "42",
      verificationCode: "abc123",
    };
    const ciphertext = encrypt(Buffer.from(JSON.stringify(payload), "utf8"), {
      version: "aes128gcm",
      dh: p256dhFromPrivate(keys.privateKey),
      privateKey: sender,
      authSecret: keys.auth,
    });

    expect(decryptPushBody(ciphertext, keys.privateKey, keys.auth)).toEqual(
      payload,
    );
  });

  it("rejects a payload encrypted to a different key", () => {
    const ours = generatePushKeys();
    const theirs = generatePushKeys();
    const sender = createECDH("prime256v1");
    sender.generateKeys();

    const ciphertext = encrypt(Buffer.from('{"@type":"StateChange"}', "utf8"), {
      version: "aes128gcm",
      dh: p256dhFromPrivate(theirs.privateKey),
      privateKey: sender,
      authSecret: theirs.auth,
    });

    expect(() =>
      decryptPushBody(ciphertext, ours.privateKey, ours.auth),
    ).toThrow();
  });
});
