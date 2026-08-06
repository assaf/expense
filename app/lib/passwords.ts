import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * Auth crypto primitives: password hashing (scrypt), invite-code
 * generation, and the opaque-token + SHA-256 pair every stored secret
 * uses. Shared by the auth module, the signup flow, the OAuth server, the
 * inbound-sender verification tokens, the test seed, and the CSV migration
 * script.
 */

const SCRYPT_KEYLEN = 64;

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

/** Hash a password for storage, as `salt:hash` (hex). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `${salt}:${hash.toString("hex")}`;
}

/** Constant-time check of a password against a stored `salt:hash`. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

const INVITE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

/** Generate an 8-character account invite code (e.g. "K7M2QXD4"). */
export function generateInviteCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) {
    code += INVITE_CHARS[byte % INVITE_CHARS.length];
  }
  return code;
}

/** Normalize a user-supplied invite code for lookup/compare. */
export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}

/** A fresh opaque token (base64url, 256 bits) — OAuth codes/tokens and the
 * inbound-sender verification links all start here. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The stored form of any token/code — SHA-256 hex, for indexed lookups.
 * One hashing primitive backs every stored secret (OAuth token/code tables
 * and sender-verification tokens), so a leaked database never exposes
 * usable tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
