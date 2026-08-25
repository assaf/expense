import { hash, randomBytes } from "node:crypto";
import { PUBLIC_URL } from "~/lib/env";
import { generateOpaqueToken, hashToken, safeEqual } from "~/lib/passwords";
import {
  createOAuthCode,
  createOAuthToken,
  findOAuthClient,
  findOAuthToken,
  revokeOAuthToken,
} from "~/lib/db/oauth";
import type { OAuthClientRecord, OAuthTokenRecord } from "~/lib/types";

/** Re-exported so the token/code routes hash secrets and compare values
 * the shared way. */
export { hashToken, safeEqual };

/**
 * The MCP authorization server (OAuth 2.1 with PKCE) for the /mcp endpoint.
 *
 * Flow: an MCP client discovers `/.well-known/oauth-authorization-server`,
 * registers itself (dynamic client registration, RFC 7591), opens the
 * authorization endpoint in a browser where the user signs in with their
 * normal account and approves the connection, and exchanges the resulting
 * code (PKCE-verified) for tokens at the token endpoint. The access token
 * then authenticates /mcp like an API token does, but no token management
 * is needed; the user just signs in.
 *
 * Tokens are opaque random strings (`oat_…` access, `ort_…` refresh) whose
 * SHA-256 hashes are stored in Postgres, mirroring the api_tokens design:
 * a leaked database never exposes usable tokens. Access tokens live 1 hour;
 * refresh tokens 30 days and rotate on every grant.
 */

/** Access token lifetime in seconds. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** Refresh token lifetime in seconds (30 days). */
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
/** Authorization codes expire after 10 minutes (RFC 6749 §4.1.2). */
const CODE_TTL_MS = 10 * 60 * 1000;
/** The only PKCE method we accept (RFC 7636 requires S256 for OAuth 2.1). */
export const PKCE_METHOD = "S256";

// --- Primitives ------------------------------------------------------------

/** A random opaque token with a recognizable prefix. */
function randomToken(prefix: "oat" | "ort" | "code"): string {
  const raw = generateOpaqueToken();
  return prefix === "code" ? raw : `${prefix}_${raw}`;
}

/** RFC 7636 S256 challenge: base64url(sha256(code_verifier)) without padding. */
export function pkceChallenge(codeVerifier: string): string {
  return hash("sha256", codeVerifier, "base64url");
}

/** A fresh PKCE verifier (43–128 chars per RFC 7636). */
export function generateCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

// --- Authorization server metadata -----------------------------------------

/**
 * RFC 8414 authorization server metadata for the current origin. Served at
 * `/.well-known/oauth-authorization-server` (and mirrored at
 * `/.well-known/openid-configuration` for clients that look there first).
 */
function buildOAuthMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    code_challenge_methods_supported: [PKCE_METHOD],
    scopes_supported: [],
  };
}

/**
 * The authorization-server metadata Response for a request. Served at every
 * discovery URL: the RFC 8414 root, its OpenID mirror, and the path-aware
 * variants (`/.well-known/oauth-authorization-server/mcp`) that newer SDK
 * clients probe first when the MCP server URL has a path.
 */
/**
 * The origin this server advertises publicly: the issuer of the OAuth
 * metadata and the base of every endpoint URL. Resolution order:
 *  1. PUBLIC_URL, when configured (the explicit answer for any proxy setup);
 *  2. the request's own origin when it arrived over https;
 *  3. behind a TLS-terminating proxy (request over http + `x-forwarded-proto:
 *     https`, e.g. a local https://expense.localhost Caddy setup) the
 *     forwarded proto/host; otherwise clients see the proxy-internal http
 *     origin and refuse to authenticate ("Protected resource … does not
 *     match expected …").
 */
export function publicOrigin(request: Request): string {
  if (PUBLIC_URL) return new URL(PUBLIC_URL).origin;
  const url = new URL(request.url);
  if (url.protocol === "https:") return url.origin;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto === "https") {
    const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    return `https://${host ?? url.host}`;
  }
  return url.origin;
}

export function oauthMetadataResponse(request: Request): Response {
  return Response.json(buildOAuthMetadata(publicOrigin(request)), {
    headers: { "Cache-Control": "no-store" },
  });
}

/** OAuth error response per RFC 6749 §5.2: `{ error, error_description }`.
 * Shared by the token and revocation endpoints. */
export function oauthError(
  status: number,
  error: string,
  description: string,
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

// --- Client registration ---------------------------------------------------

/** True when a redirect URI is acceptable: https, or http on loopback. */
function isValidRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }
  return false;
}

/**
 * Build a registered client from RFC 7591 registration metadata. Returns an
 * error message when the metadata is invalid; otherwise the client record
 * plus the plaintext secret (confidential clients only, shown once).
 */
export function buildRegisteredClient(input: {
  clientId: string;
  name: string;
  redirectUris: string[];
  authMethod: "none" | "client_secret_basic";
}): {
  error?: string;
  client?: OAuthClientRecord;
  secret?: string;
} {
  const name = input.name.trim() || "MCP client";
  if (name.length > 200) return { error: "client_name is too long." };
  if (input.redirectUris.length === 0) {
    return { error: "redirect_uris must include at least one URI." };
  }
  if (input.redirectUris.length > 10) {
    return { error: "Too many redirect_uris (max 10)." };
  }
  for (const uri of input.redirectUris) {
    if (!isValidRedirectUri(uri)) {
      return {
        error: `Redirect URI "${uri}" must be https (or http on localhost).`,
      };
    }
  }
  let secret: string | undefined;
  let secretHash: string | null = null;
  if (input.authMethod === "client_secret_basic") {
    secret = randomToken("oat");
    secretHash = hashToken(secret);
  }
  return {
    client: {
      id: input.clientId,
      secretHash,
      name,
      redirectUris: input.redirectUris,
      authMethod: input.authMethod,
      createdAt: "",
    },
    secret,
  };
}

// --- Tokens ----------------------------------------------------------------

/** Issue an access + refresh token pair for a user + client. */
export async function issueTokenPair(
  userId: string,
  clientId: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const now = Date.now();
  const accessToken = randomToken("oat");
  const refreshToken = randomToken("ort");
  await Promise.all([
    createOAuthToken({
      tokenHash: hashToken(accessToken),
      userId,
      clientId,
      type: "access",
      scope: "",
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    }),
    createOAuthToken({
      tokenHash: hashToken(refreshToken),
      userId,
      clientId,
      type: "refresh",
      scope: "",
      expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    }),
  ]);
  return { accessToken, refreshToken };
}

/**
 * The validity guard for a stored token row: it must exist, be of the
 * expected type (optionally bound to a client), and be neither revoked nor
 * expired. Returns the row, or undefined when any guard fails.
 */
function validToken(
  row: OAuthTokenRecord | undefined,
  type: OAuthTokenRecord["type"],
  clientId?: string,
): OAuthTokenRecord | undefined {
  if (!row) return undefined;
  if (row.type !== type) return undefined;
  if (clientId !== undefined && row.clientId !== clientId) return undefined;
  if (row.revokedAt) return undefined;
  if (row.expiresAt <= new Date().toISOString()) return undefined;
  return row;
}

/**
 * Verify an access token and return the user it belongs to. Used by the
 * /mcp endpoint: a valid token authenticates the user → their account.
 */
export async function verifyAccessToken(
  token: string,
): Promise<{ userId: string; clientId: string } | undefined> {
  const row = validToken(await findOAuthToken(hashToken(token)), "access");
  if (!row) return undefined;
  return { userId: row.userId, clientId: row.clientId };
}

/** True when a bearer value looks like one of our OAuth tokens. */
export function isOAuthToken(value: string): boolean {
  return /^(oat|ort)_[A-Za-z0-9_-]{32,}$/.test(value);
}

/**
 * Validate a refresh token for a client and rotate it: the old refresh token
 * is revoked and a fresh pair is issued. Returns undefined for unknown,
 * revoked, expired, or mismatched tokens.
 */
export async function rotateRefreshToken(
  client: OAuthClientRecord,
  refreshToken: string,
): Promise<
  { accessToken: string; refreshToken: string; userId: string } | undefined
> {
  const row = validToken(
    await findOAuthToken(hashToken(refreshToken)),
    "refresh",
    client.id,
  );
  if (!row) return undefined;
  await revokeOAuthToken(row.tokenHash);
  const pair = await issueTokenPair(row.userId, client.id);
  return { ...pair, userId: row.userId };
}

// --- Client authentication on token/revoke endpoints -----------------------

/**
 * The client's own credentials on the token/revocation endpoints: clients
 * registered with `token_endpoint_auth_method: none` send client_id as a
 * parameter; confidential clients send HTTP Basic. Returns the client, or
 * an error message when the credentials don't check out.
 */
async function authenticateClient(
  clientId: string | null,
  basicHeader: string | null,
): Promise<{ client?: OAuthClientRecord; error?: string }> {
  let id = clientId;
  let secret: string | null = null;
  if (basicHeader) {
    if (!basicHeader.startsWith("Basic ")) {
      return { error: "invalid_client: unsupported authorization scheme." };
    }
    try {
      const decoded = Buffer.from(basicHeader.slice(6), "base64").toString(
        "utf8",
      );
      const colon = decoded.indexOf(":");
      if (colon < 0) return { error: "invalid_client: malformed credentials." };
      id = decoded.slice(0, colon);
      secret = decoded.slice(colon + 1);
    } catch {
      return { error: "invalid_client: malformed credentials." };
    }
  }
  if (!id) return { error: "invalid_client: client_id is required." };
  const client = await findOAuthClient(id);
  if (!client) return { error: "invalid_client: unknown client." };

  if (client.authMethod === "client_secret_basic") {
    if (
      !secret ||
      !client.secretHash ||
      !safeEqual(client.secretHash, hashToken(secret))
    ) {
      return { error: "invalid_client: bad client secret." };
    }
  } else if (secret !== null) {
    // A "none" client that presented Basic is rejected rather than ignored.
    return { error: "invalid_client: client does not use client secrets." };
  }
  return { client };
}

/**
 * Parse a form-urlencoded POST and authenticate the client from the
 * `client_id` parameter and/or HTTP Basic header. Returns either the parsed
 * form plus the authenticated client, or the error response to return.
 * Shared by the token and revoke endpoints (RFC 6749 §2.3 / RFC 7009 §2.1;
 * both authenticate the client the same way).
 */
export async function authenticateFormRequest(
  request: Request,
): Promise<
  { form: URLSearchParams; client: OAuthClientRecord } | { error: Response }
> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return {
      error: oauthError(
        400,
        "invalid_request",
        "Content-Type must be application/x-www-form-urlencoded.",
      ),
    };
  }
  const form = new URLSearchParams(await request.text());
  const auth = await authenticateClient(
    form.get("client_id"),
    request.headers.get("authorization"),
  );
  if (auth.error || !auth.client) {
    return {
      error: oauthError(400, "invalid_client", auth.error ?? "invalid_client"),
    };
  }
  return { form, client: auth.client };
}

/** Generate an authorization code, store it, and return the raw code. */
export async function issueAuthorizationCode(input: {
  userId: string;
  client: OAuthClientRecord;
  redirectUri: string;
  codeChallenge: string;
}): Promise<string> {
  const code = randomToken("code");
  await createOAuthCode({
    id: hashToken(code),
    userId: input.userId,
    clientId: input.client.id,
    challenge: input.codeChallenge,
    redirectUri: input.redirectUri,
    expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  });
  return code;
}
