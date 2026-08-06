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

/** Current scrypt cost — N=2^16 (memory-hard, RFC 7914). The derived key
 * needs ~64 MiB of working memory (128·N·r), so parallel/GPU cracking of
 * one hash is expensive; the parameters are embedded in every stored hash
 * (see `hashPassword`), so the cost can be raised later without breaking
 * hashes stored with older parameters. */
const SCRYPT_N = 65_536;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** scrypt's working memory for N=2^16 is ~64 MiB — allow up to 128 MiB so
 * derivation never trips Node's 32 MiB default maxmem. */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/** The scrypt parameters a stored hash was derived with. */
interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

const CURRENT_PARAMS: ScryptParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };

/** Pre-format-change rows (`salt:hash` hex) were derived with Node's scrypt
 * defaults: N=2^14, r=8, p=1, keylen 64. */
const LEGACY_PARAMS: ScryptParams = { N: 16_384, r: 8, p: 1 };

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

function derive(
  password: string,
  salt: string,
  params: ScryptParams,
): Promise<Buffer> {
  return scrypt(password, salt, SCRYPT_KEYLEN, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Hash a password for storage as a self-describing scrypt string:
 * `$scrypt$N=…,r=…,p=…$<salt-b64url>$<hash-b64url>`. Salt is 16 random
 * bytes per password; the parameters are embedded so the cost factor can
 * be raised later without invalidating hashes stored with older
 * parameters (see `needsRehash`). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const hash = await derive(password, salt, CURRENT_PARAMS);
  return `$scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt}$${hash.toString("base64url")}`;
}

/** Parse a stored hash into its parameters, salt, and derived key — the
 * self-describing `$scrypt$N=…,r=…,p=…$salt$hash` format or the legacy
 * `salt:hash` (hex) rows from before the format change. null when the
 * string isn't a valid hash (fails closed: garbage can't authenticate). */
function parseStored(
  stored: string,
): { params: ScryptParams; salt: string; hash: Buffer } | null {
  if (stored.startsWith("$scrypt$")) {
    const [paramsPart, salt, hashPart, ...rest] = stored
      .slice("$scrypt$".length)
      .split("$");
    if (rest.length > 0 || !paramsPart || !salt || !hashPart) return null;
    const params = parseScryptParams(paramsPart);
    if (!params) return null;
    const hash = Buffer.from(hashPart, "base64url");
    if (hash.length !== SCRYPT_KEYLEN) return null;
    return { params, salt, hash };
  }
  // Legacy `salt:hash` — derived with the default scrypt cost.
  const [salt, hashHex, ...rest] = stored.split(":");
  if (rest.length > 0 || !salt || !hashHex) return null;
  const hash = Buffer.from(hashHex, "hex");
  if (hash.length !== SCRYPT_KEYLEN) return null;
  return { params: LEGACY_PARAMS, salt, hash };
}

/** "N=65536,r=8,p=1" → params. N must be a power of two and r/p positive
 * integers (scrypt throws otherwise), and the working memory must fit the
 * allowed budget — anything else fails closed at parse time. */
function parseScryptParams(part: string): ScryptParams | null {
  const params: Partial<ScryptParams> = {};
  for (const chunk of part.split(",")) {
    const [key, value] = chunk.split("=");
    if (key === "N") params.N = Number(value);
    else if (key === "r") params.r = Number(value);
    else if (key === "p") params.p = Number(value);
    else return null;
  }
  const { N, r, p } = params;
  if (
    N === undefined ||
    r === undefined ||
    p === undefined ||
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 2 ||
    r < 1 ||
    p < 1 ||
    (N & (N - 1)) !== 0 ||
    128 * N * r > SCRYPT_MAXMEM
  ) {
    return null;
  }
  return { N, r, p };
}

/** Constant-time check of a password against a stored hash — any format
 * the app has written (self-describing or legacy `salt:hash`). */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  const hash = await derive(password, parsed.salt, parsed.params);
  return (
    hash.length === parsed.hash.length && timingSafeEqual(hash, parsed.hash)
  );
}

/** True when a stored hash used parameters below the current cost (legacy
 * `salt:hash` rows or an older self-describing string) — the login path
 * rehashes with the current parameters on the next successful sign-in. */
export function needsRehash(stored: string): boolean {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  return (
    parsed.params.N !== CURRENT_PARAMS.N ||
    parsed.params.r !== CURRENT_PARAMS.r ||
    parsed.params.p !== CURRENT_PARAMS.p
  );
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
