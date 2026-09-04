import { createHash, randomBytes } from "node:crypto";
import { FASTMAIL_OAUTH_CLIENT_ID } from "~/lib/env";
import { updateEmailConnectionTokens } from "~/lib/db/email-connections";
import { decryptSecret, encryptSecret } from "~/lib/token-crypto.server";

/**
 * "Connect with Fastmail" OAuth 2.0 (Authorization Code + PKCE, public
 * client — Fastmail issues no client secret). Endpoint shapes per
 * https://www.fastmail.com/for-developers/oauth/: the token endpoint is
 * confusingly named /oauth/refresh; it serves both the authorization-code
 * exchange and refresh grants. An OAuth access token authenticates JMAP
 * exactly like an API token (Bearer), so the whole mail pipeline is
 * untouched; only credential acquisition, storage, and refresh live here.
 *
 * Like jmap.server.ts, the client id is read from env.ts; the module is
 * env-gated end to end — when FASTMAIL_OAUTH_CLIENT_ID is unset the UI
 * hides the OAuth entry points and the token-paste flow remains the only
 * connect path.
 */

const OAUTH_AUTHORIZE_URL = "https://api.fastmail.com/oauth/authorize";
const OAUTH_TOKEN_URL = "https://api.fastmail.com/oauth/refresh";

/**
 * Mail read/write covers the Trash move + Inbox import; core covers the
 * session fetch and PushSubscription/set. Deliberately no jmap:submission:
 * Fastmail API tokens can't submit mail anyway (confirmations are imported,
 * not sent), so the least privilege matches the pipeline's real needs.
 */
const OAUTH_SCOPES = "urn:ietf:params:jmap:core urn:ietf:params:jmap:mail";

// --- Redirect-flow session state ---------------------------------------------

/** Session key for the in-flight OAuth handshake: CSRF state, PKCE
 * verifier, and the allowlisted resume target. */
export const FM_OAUTH_SESSION_KEY = "fmOAuth";

/**
 * Session key for the anonymous onboarding path's post-callback
 * credentials. Token fields are AES-encrypted BEFORE entering the session:
 * cookie sessions are signed, not encrypted.
 */
export const FM_PENDING_SESSION_KEY = "fmPending";

export const FM_OAUTH_MAX_AGE_S = 600;

export interface FmOAuthFlow {
  state: string;
  verifier: string;
  /** Allowlisted resume target ("onboarding" | "emails"), never a path. */
  next: "onboarding" | "emails";
  ts: number;
}

export interface FmPendingConnection {
  username: string;
  mailAccountId: string;
  tokenEnc: string;
  refreshTokenEnc: string;
  expiresAt: string;
}

/** Explicit staleness check: correctness does not depend on the cookie's
 * maxAge option surviving commitSession. */
export function isFlowStale(flow: FmOAuthFlow): boolean {
  return Date.now() - flow.ts > FM_OAUTH_MAX_AGE_S * 1000;
}

/** Refresh this long before expiry so concurrent JMAP calls never race a
 * dying token (Fastmail access tokens live ~1h). */
const REFRESH_SKEW_MS = 60_000;

const REQUEST_TIMEOUT_MS = 15_000;

export function isFastmailOAuthConfigured(): boolean {
  return FASTMAIL_OAUTH_CLIENT_ID.length > 0;
}

/** The registered client id at call time (env.ts caches at import; the
 * redirect route needs the live value). Empty string when unconfigured. */
export function fastmailOAuthClientId(): string {
  return FASTMAIL_OAUTH_CLIENT_ID;
}

export interface OAuthTokenSet {
  accessToken: string;
  /** Rotates on every grant; the caller MUST persist the new value
   * (reusing a stale one revokes the whole authorization). */
  refreshToken: string;
  /** ISO timestamp when accessToken dies. */
  expiresAt: string;
}

/** RFC 7636 S256 pair: verifier is 43 base64url chars (Fastmail's minimum),
 * challenge = BASE64URL(SHA256(verifier)). */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

async function requestTokenSet(
  form: Record<string, string>,
): Promise<OAuthTokenSet> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Fastmail token endpoint returned HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const body = JSON.parse(text) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.expires_in !== "number"
  ) {
    throw new Error("Fastmail token endpoint returned an unexpected shape");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  };
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<OAuthTokenSet> {
  return requestTokenSet({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    client_id: FASTMAIL_OAUTH_CLIENT_ID,
  });
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<OAuthTokenSet> {
  return requestTokenSet({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: FASTMAIL_OAUTH_CLIENT_ID,
  });
}

/** The credential fields the resolver needs; `EmailConnectionWithSecret`
 * satisfies this structurally (the view never carries secrets). */
export interface ConnectionCredentials {
  id: string;
  tokenEnc: string;
  /** OAuth only; null/absent for legacy API-token connections. */
  refreshTokenEnc?: string | null;
  /** "gmail" routes the resolver to the Google refresh flow; absent or
   * "fastmail" uses the JMAP path. */
  provider?: string;
  tokenExpiresAt?: string | null;
}

// Concurrent JMAP calls share one connection and can each hit expiry;
// dedup them on a single refresh per connection (same pattern as
// jmapSessionForToken), evicting on settle so a failure retries.
const inflightRefreshes = new Map<string, Promise<string>>();

/**
 * The single credential resolver for every connection-token consumer:
 * legacy API-token rows decrypt straight through (behavior identical to
 * the pre-OAuth code); OAuth rows return the cached access token until
 * 60s before expiry, then refresh and persist the rotated credentials.
 * Throws on refresh failure (callers' catch blocks flag the row error).
 */
export async function connectionAccessToken(
  connection: ConnectionCredentials,
): Promise<string> {
  // Gmail rows resolve through the Google refresh flow. Dynamic import
  // keeps the module graph acyclic (google-oauth reuses this module's
  // PKCE + staleness helpers).
  if (connection.provider === "gmail") {
    const { gmailAccessToken } = await import("~/lib/google-oauth.server");
    return gmailAccessToken(connection);
  }
  if (!connection.refreshTokenEnc) {
    return decryptSecret(connection.tokenEnc);
  }
  const expiresAt = connection.tokenExpiresAt
    ? Date.parse(connection.tokenExpiresAt)
    : 0;
  const accessToken = decryptSecret(connection.tokenEnc);
  if (expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return accessToken;
  }
  let pending = inflightRefreshes.get(connection.id);
  if (!pending) {
    pending = refreshAccessToken(decryptSecret(connection.refreshTokenEnc))
      .then(async (tokens) => {
        await updateEmailConnectionTokens({
          id: connection.id,
          tokenEnc: encryptSecret(tokens.accessToken),
          refreshTokenEnc: encryptSecret(tokens.refreshToken),
          tokenExpiresAt: tokens.expiresAt,
        });
        return tokens.accessToken;
      })
      .then(
        (token) => {
          inflightRefreshes.delete(connection.id);
          return token;
        },
        (err) => {
          inflightRefreshes.delete(connection.id);
          throw err;
        },
      );
    inflightRefreshes.set(connection.id, pending);
  }
  return pending;
}
