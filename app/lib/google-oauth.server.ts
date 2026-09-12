import { createHash } from "node:crypto";
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_PUBSUB_AUDIENCE,
  GOOGLE_PUBSUB_TOPIC,
} from "~/lib/env";
import { SITE_URL } from "~/lib/seo-content";
import type {
  ConnectionCredentials,
  FmOAuthFlow,
} from "~/lib/fastmail-oauth.server";
import {
  requestTokenSet,
  resolveConnectionAccessToken,
} from "~/lib/oauth-token-refresh.server";

/**
 * "Connect with Gmail" OAuth 2.0 (Authorization Code + PKCE, confidential
 * client). Mirrors fastmail-oauth.server.ts: the flow struct parks state +
 * PKCE verifier in the session, the pending struct parks post-callback
 * credentials for the anonymous onboarding path. Token fields are
 * AES-encrypted BEFORE entering the session: cookie sessions are signed,
 * not encrypted.
 *
 * Scope rule: only `gmail.modify` (+ `openid email`). The pipeline never
 * sends mail; report/confirmation emails reach the owner's inbox via
 * `messages.import`. See gmail.server.ts.
 */

const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const OAUTH_SCOPES =
  "https://www.googleapis.com/auth/gmail.modify openid email";

export const GOOGLE_OAUTH_SESSION_KEY = "googleOAuth";
export const GOOGLE_PENDING_SESSION_KEY = "googlePending";
export const GOOGLE_OAUTH_MAX_AGE_S = 600;

/** Session-parked in-flight handshake; same shape as the Fastmail flow. */
export type GoogleOAuthFlow = FmOAuthFlow;

/**
 * Session-parked credentials from the anonymous (onboarding) callback.
 * Gmail has no mailbox account id; `remoteAccountId` is the Google `sub`.
 */
export interface GooglePendingConnection {
  /** Discriminates the union with FmPendingConnection in
   * completeOnboarding. */
  provider: "gmail";
  emailAddress: string;
  remoteAccountId: string;
  tokenEnc: string;
  refreshTokenEnc: string | null;
  expiresAt: string;
}

export function isGmailOAuthConfigured(): boolean {
  return (
    GOOGLE_OAUTH_CLIENT_ID.length > 0 &&
    GOOGLE_OAUTH_CLIENT_SECRET.length > 0 &&
    GOOGLE_PUBSUB_TOPIC.length > 0
  );
}

/** Expected `aud` on Pub/Sub push JWTs; overridable via env for
 * non-default subscription audiences. */
export function gmailPushAudience(): string {
  return (
    GOOGLE_PUBSUB_AUDIENCE || `${SITE_URL}/api/email-connections-gmail-push`
  );
}

export interface GmailTokenSet {
  accessToken: string;
  /** Google does not rotate refresh tokens: null means "keep the stored
   * one" (the response omitted refresh_token). */
  refreshToken: string | null;
  expiresAt: number;
  /** Signed but unverified (fetched over TLS from Google's token endpoint);
   * payload carries `sub`, used as the Gmail remoteAccountId. */
  idToken: string | null;
}

/** The authorize URL for a flow: consent is forced so Google issues a
 * refresh_token even for users who granted the app before. */
export function buildGmailAuthorizeUrl(input: {
  state: string;
  verifier: string;
  redirectUri: string;
}): string {
  const challenge = createHash("sha256")
    .update(input.verifier)
    .digest("base64url");
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: input.state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/** The Gmail set: an epoch-ms expiry (routes park and store it as a
 * number), Google's unrotated refresh token, and its id_token. */
async function requestGmailTokenSet(
  form: Record<string, string>,
): Promise<GmailTokenSet> {
  const tokens = await requestTokenSet(OAUTH_TOKEN_URL, form, "Google");
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    idToken: tokens.idToken,
  };
}

export async function exchangeGmailAuthorizationCode(input: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<GmailTokenSet> {
  return requestGmailTokenSet({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
  });
}

/** What the shared resolver needs out of a Gmail refresh: the access token,
 * an ISO expiry (the set above carries epoch ms), and Google's unrotated
 * refresh token, null when the response omitted it. */
interface RefreshedGmailTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
}

async function refreshGmailAccessToken(
  refreshToken: string,
): Promise<RefreshedGmailTokens> {
  const tokens = await requestGmailTokenSet({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
  });
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(tokens.expiresAt).toISOString(),
  };
}

/** base64url-decode an id_token's payload (no signature check: the token
 * arrived over TLS directly from Google's token endpoint). */
export function decodeGoogleIdToken(idToken: string): {
  sub?: string;
  email?: string;
} {
  const part = idToken.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      sub?: string;
      email?: string;
    };
  } catch {
    return {};
  }
}

/**
 * The credential resolver for Gmail connections: the shared path returns
 * the cached access token until 60s before expiry, then refreshes and
 * persists the rotated credentials. Google never rotates refresh tokens, so
 * an omitted refresh_token keeps the stored one (null would clear it).
 * Throws on refresh failure (callers' catch blocks flag the row error).
 */
export async function gmailAccessToken(
  connection: ConnectionCredentials,
): Promise<string> {
  return resolveConnectionAccessToken({
    connection,
    refresh: refreshGmailAccessToken,
    // Google keeps the stored refresh token when the response omits one; a
    // response that carries a new one replaces it.
    persistRefreshToken: (tokens: RefreshedGmailTokens, stored: string) =>
      tokens.refreshToken || stored,
  });
}
