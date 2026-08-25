import { authenticateFormRequest, hashToken } from "~/lib/oauth.server";
import { findOAuthToken, revokeOAuthToken } from "~/lib/db/oauth";
import type { Route } from "./+types/oauth.revoke";

/**
 * POST /oauth/revoke: token revocation (RFC 7009). Revokes an access or
 * refresh token; unknown, expired, or already-revoked tokens are a no-op
 * success per the spec. Client authentication mirrors the token endpoint.
 */
export async function action({ request }: Route.ActionArgs) {
  const parsed = await authenticateFormRequest(request);
  if ("error" in parsed) return parsed.error;
  const { form, client } = parsed;
  const token = form.get("token") ?? "";
  const row = await findOAuthToken(hashToken(token));
  // Only tokens belonging to this client are revoked.
  if (row && row.clientId === client.id) {
    await revokeOAuthToken(row.tokenHash);
  }
  return new Response(null, { status: 200 });
}
