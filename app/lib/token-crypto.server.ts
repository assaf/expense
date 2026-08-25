import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EMAIL_TOKEN_ENCRYPTION_KEY } from "~/lib/env";

/**
 * AES-256-GCM encryption for connected email-account API tokens. The tokens
 * must be usable later (JMAP calls on the user's behalf), so unlike session
 * or OAuth secrets they cannot be hashed; encrypt them at rest instead.
 *
 * Ciphertext format: `base64(iv).base64(tag).base64(ciphertext)`. The tag
 * makes tampering detectable, the random IV makes repeats non-deterministic.
 *
 * Requires EMAIL_TOKEN_ENCRYPTION_KEY (32 bytes, base64); `isTokenCryptoConfigured`
 * gates the Settings UI so the app degrades to "feature not configured"
 * instead of crashing at decrypt time.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;

export function isTokenCryptoConfigured(): boolean {
  return EMAIL_TOKEN_ENCRYPTION_KEY.length > 0;
}

function key(): Buffer {
  const buf = Buffer.from(EMAIL_TOKEN_ENCRYPTION_KEY, "base64");
  if (buf.byteLength !== KEY_BYTES) {
    throw new Error(
      `EMAIL_TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (base64) — got ${buf.byteLength}`,
    );
  }
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptSecret(packed: string): string {
  const [ivB64, tagB64, ctB64] = packed.split(".");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("Malformed encrypted secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
