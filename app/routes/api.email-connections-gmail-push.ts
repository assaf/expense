import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { GOOGLE_PUSH_SERVICE_ACCOUNT } from "~/lib/env";
import { captureWarning } from "~/lib/errors.server";
import {
  findEmailConnectionByAddress,
  readEmailConnectionByAddressSecret,
  setEmailConnectionStatus,
  touchEmailConnectionPush,
} from "~/lib/db/email-connections";
import { drainEmailConnection } from "~/lib/email-connection-process.server";
import { gmailPushAudience } from "~/lib/google-oauth.server";
import type { Route } from "./+types/api.email-connections-gmail-push";

/**
 * Webhook for CONNECTED Gmail/Google Workspace accounts (Pub/Sub push).
 * Gmail publishes new-INBOX-mail notifications to the app's Pub/Sub topic
 * (set up by users.watch); the topic's push subscription POSTs here with
 * an OIDC JWT. Signature/iss/aud/exp alone are NOT sufficient auth: any
 * GCP project can point a push subscription at this public URL and Google
 * signs those tokens too, so the JWT's `email` claim must equal
 * GOOGLE_PUSH_SERVICE_ACCOUNT (the SA configured on OUR subscription).
 * Unset -> 503 (Pub/Sub retries; the daily cron is the catch-up net).
 *
 * Body: Pub/Sub push envelope `{ message: { data } }`, `data` being
 * base64url JSON `{ emailAddress, historyId }` (1MB body cap, mirroring
 * the Fastmail webhook). The drain is lookback-based with EmailProcessLog
 * dedupe, so historyId is informational only.
 *
 * Pub/Sub retries non-2xx deliveries: an unknown (or non-Gmail) mailbox
 * answers 200 { drained: false } so a stale subscription can never wedge
 * the queue, while auth/body failures use their real status codes. Drain
 * failure flags the connection error and still returns 200 — the daily
 * cron (/api/email-connections-cron) is the catch-up net.
 */

// Vercel: the drain pipeline needs the full budget.
export const config = { maxDuration: 60 };

// Mirrors the Fastmail webhook's body cap (readFastMailPush).
const MAX_BODY_BYTES = 1024 * 1024;

// --- Pub/Sub push OIDC JWT verification (hand-rolled; no jose dep) ----------

interface JwksEntry {
  kid: string;
  jwk: Record<string, unknown>;
}
let jwksCache: { keys: JwksEntry[]; fetchedAt: number } | undefined;
let jwksInflight: Promise<JwksEntry[]> | undefined;
let lastForcedJwksRefetchAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000;
// A kid-miss forced refetch may not run more often than this: without the
// floor, junk requests with random kids each force an outbound fetch (the
// inflight dedupe only collapses concurrent ones). Keyed to FORCED
// refetches, not cache age — a fresh rotation right after a normal cache
// fill must still be allowed to trigger its one refetch.
const JWKS_REFETCH_FLOOR_MS = 30_000;

async function googleJwks(): Promise<JwksEntry[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  // Share one fetch across concurrent misses (a kid-miss flood otherwise
  // piles onto parallel refetches).
  if (jwksInflight) return jwksInflight;
  jwksInflight = (async () => {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/certs", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`JWKS fetch returned HTTP ${res.status}`);
    const body = (await res.json()) as {
      keys?: Array<Record<string, unknown>>;
    };
    const keys = (body.keys ?? [])
      .filter(
        (k): k is { kid: string } & Record<string, unknown> =>
          typeof k.kid === "string",
      )
      .map((k) => ({ kid: k.kid, jwk: k }));
    jwksCache = { keys, fetchedAt: Date.now() };
    return keys;
  })().finally(() => {
    jwksInflight = undefined;
  });
  return jwksInflight;
}

function b64urlToJson(part: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as
      | Record<string, unknown>
      | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify a Pub/Sub push JWT: RS256 signature against Google's JWKS
 * (matched by kid), iss accounts.google.com, aud = the configured push
 * audience, exp in the future. Returns the token's claims, or undefined
 * on any failure (the route fails closed with 401).
 */
async function verifyPushJwt(
  token: string,
): Promise<{ email?: string } | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const header = b64urlToJson(parts[0]!);
  const payload = b64urlToJson(parts[1]!);
  if (header?.alg !== "RS256" || typeof header.kid !== "string") {
    return undefined;
  }
  // Google rotates JWKS keys; an unknown kid most likely means the cache
  // predates the rotation, so force one refetch — but no more often than
  // JWKS_REFETCH_FLOOR_MS: junk requests with random kids must not each
  // force an outbound fetch (jwksInflight dedupes concurrent ones). The
  // floor is keyed to FORCED refetches, not cache age, so a rotation
  // right after a normal cache fill still triggers its one refetch.
  let keys = await googleJwks();
  let [jwk] = keys.filter((k) => k.kid === header.kid);
  if (!jwk) {
    if (Date.now() - lastForcedJwksRefetchAt >= JWKS_REFETCH_FLOOR_MS) {
      lastForcedJwksRefetchAt = Date.now();
      jwksCache = undefined;
      keys = await googleJwks();
      [jwk] = keys.filter((k) => k.kid === header.kid);
    }
    if (!jwk) return undefined;
  }
  const key = createPublicKey({ key: jwk.jwk, format: "jwk" });
  const ok = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2]!, "base64url"),
  );
  if (!ok) return undefined;

  const iss = typeof payload?.iss === "string" ? payload.iss : "";
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") {
    return undefined;
  }
  if (payload?.aud !== gmailPushAudience()) return undefined;
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp * 1000 <= Date.now()) return undefined;
  return payload as { email?: string };
}

// --- Route ---------------------------------------------------------------------

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  if (!GOOGLE_PUSH_SERVICE_ACCOUNT) {
    // Fail closed: without the pin, signature/iss/aud/exp accept tokens
    // minted by ANY GCP project's push subscription aimed at this URL.
    return Response.json(
      { error: "push service account is not configured" },
      { status: 503 },
    );
  }
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  let claims: { email?: string } | undefined;
  try {
    claims = token ? await verifyPushJwt(token) : undefined;
  } catch (err) {
    // A JWKS fetch failure is infrastructure, not auth: 503 so Pub/Sub
    // retries, without an unhandled exception per push.
    captureWarning("[gmail-push] JWKS verification failed:", {
      error: err,
    });
    return Response.json(
      { error: "verification temporarily unavailable" },
      { status: 503 },
    );
  }
  if (!claims) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Bind the token to OUR push subscription's service account: iss/aud
  // are identical for every Google customer's push tokens.
  if (
    typeof claims.email !== "string" ||
    claims.email.toLowerCase() !== GOOGLE_PUSH_SERVICE_ACCOUNT.toLowerCase()
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let emailAddress: unknown;
  try {
    // Mirror the Fastmail webhook's 1MB cap (Pub/Sub messages are small;
    // the cap bounds memory for valid-JWT garbage bodies).
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: "body too large" }, { status: 413 });
    }
    const body = JSON.parse(raw.toString("utf8")) as {
      message?: { data?: unknown };
    };
    const data = body.message?.data;
    if (typeof data !== "string") throw new Error("missing message.data");
    ({ emailAddress } = JSON.parse(
      Buffer.from(data, "base64url").toString("utf8"),
    ) as { emailAddress?: unknown });
  } catch {
    return Response.json({ error: "malformed body" }, { status: 400 });
  }
  if (typeof emailAddress !== "string" || !emailAddress) {
    return Response.json({ error: "malformed body" }, { status: 400 });
  }

  const found = await findEmailConnectionByAddress(emailAddress);
  const connection = found
    ? await readEmailConnectionByAddressSecret(emailAddress)
    : undefined;
  if (!connection || connection.provider !== "gmail") {
    // Never retry a mailbox we don't serve (Pub/Sub retries non-2xx).
    console.warn("[gmail-push] ignoring unknown or non-gmail mailbox", {
      emailAddress,
    });
    return Response.json({ ok: true, drained: false });
  }

  try {
    await touchEmailConnectionPush(connection.id);
    const result = await drainEmailConnection(connection);
    console.info("[gmail-push] drained", {
      connectionId: connection.id,
      ...result,
    });
    // Success clears the needs-attention flag.
    if (connection.status === "error") {
      await setEmailConnectionStatus(connection.id, "active").catch(() => {});
    }
  } catch (err) {
    captureWarning("[gmail-push] drain failed:", {
      connectionId: connection.id,
      error: err,
    });
    await setEmailConnectionStatus(connection.id, "error").catch(() => {});
  }
  return Response.json({ ok: true, drained: true });
}
