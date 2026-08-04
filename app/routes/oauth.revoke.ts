import { authenticateClient, hashToken } from "~/lib/oauth.server";
import { findOAuthToken, revokeOAuthToken } from "~/lib/store.server";
import type { Route } from "./+types/oauth.revoke";

/**
 * POST /oauth/revoke — token revocation (RFC 7009). Revokes an access or
 * refresh token; unknown, expired, or already-revoked tokens are a no-op
 * success per the spec. Client authentication mirrors the token endpoint.
 */
export async function action({ request }: Route.ActionArgs) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return oauthError(
      "invalid_request",
      "Content-Type must be application/x-www-form-urlencoded.",
    );
  }
  const form = new URLSearchParams(await request.text());
  const token = form.get("token") ?? "";

  const auth = await authenticateClient(
    form.get("client_id"),
    request.headers.get("authorization"),
  );
  if (auth.error || !auth.client) {
    return oauthError("invalid_client", auth.error ?? "invalid_client");
  }

  const row = await findOAuthToken(hashToken(token));
  // Only tokens belonging to this client are revoked.
  if (row && row.clientId === auth.client.id) {
    await revokeOAuthToken(row.tokenHash);
  }
  return new Response(null, { status: 200 });
}

function oauthError(error: string, description: string): Response {
  return Response.json(
    { error, error_description: description },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
