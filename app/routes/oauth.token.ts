import {
  ACCESS_TOKEN_TTL_SECONDS,
  authenticateClient,
  hashToken,
  issueTokenPair,
  oauthError,
  pkceChallenge,
  rotateRefreshToken,
  safeEqual,
} from "~/lib/oauth.server";
import { consumeOAuthCode } from "~/lib/db/oauth";
import type { Route } from "./+types/oauth.token";

/**
 * POST /oauth/token — the OAuth token endpoint. Supports the
 * authorization_code grant (PKCE S256 required) and the refresh_token grant
 * (tokens rotate: the presented refresh token is revoked and a fresh pair
 * is issued). Client authentication: client_id parameter for "none"
 * clients, HTTP Basic for confidential clients.
 */
export async function action({ request }: Route.ActionArgs) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return oauthError(
      400,
      "invalid_request",
      "Content-Type must be application/x-www-form-urlencoded.",
    );
  }
  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");

  const auth = await authenticateClient(
    form.get("client_id"),
    request.headers.get("authorization"),
  );
  if (auth.error || !auth.client) {
    return oauthError(400, "invalid_client", auth.error ?? "invalid_client");
  }
  const client = auth.client;

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    if (!code || !verifier) {
      return oauthError(
        400,
        "invalid_request",
        "code and code_verifier are required.",
      );
    }
    const claimed = await consumeOAuthCode(hashToken(code), client.id);
    if (!claimed) {
      return oauthError(
        400,
        "invalid_grant",
        "Unknown, expired, or already-used authorization code.",
      );
    }
    if (claimed.redirectUri !== redirectUri) {
      return oauthError(
        400,
        "invalid_grant",
        "redirect_uri does not match the authorization request.",
      );
    }
    if (!safeEqual(claimed.challenge, pkceChallenge(verifier))) {
      return oauthError(400, "invalid_grant", "PKCE verification failed.");
    }
    const pair = await issueTokenPair(claimed.userId, client.id);
    return tokenResponse(pair.accessToken, pair.refreshToken);
  }

  if (grantType === "refresh_token") {
    const refresh = form.get("refresh_token") ?? "";
    if (!refresh) {
      return oauthError(400, "invalid_request", "refresh_token is required.");
    }
    const rotated = await rotateRefreshToken(client, refresh);
    if (!rotated) {
      return oauthError(
        400,
        "invalid_grant",
        "Invalid or expired refresh token.",
      );
    }
    return tokenResponse(rotated.accessToken, rotated.refreshToken);
  }

  return oauthError(
    400,
    "unsupported_grant_type",
    `Unsupported grant_type: ${grantType ?? "(missing)"}`,
  );
}

function tokenResponse(accessToken: string, refreshToken: string): Response {
  return Response.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: "",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
