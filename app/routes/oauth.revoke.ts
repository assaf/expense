import { authenticateFormRequest, hashToken } from "~/lib/oauth.server";
import {
  findOAuthToken,
  revokeOAuthToken,
  revokeOAuthTokenFamily,
} from "~/lib/db/oauth";
import type { Route } from "./+types/oauth.revoke";

/**
 * POST /oauth/revoke: token revocation (RFC 7009). Revokes an access or
 * refresh token; unknown, expired, or already-revoked tokens are a no-op
 * success per the spec. Client authentication mirrors the token endpoint.
 *
 * §2.1 asks that revoking a refresh token also invalidate the access tokens
 * issued alongside it, so a refresh token takes its whole rotation family
 * with it: otherwise a client (or a thief holding a leaked copy) keeps a
 * working access token for the rest of its hour.
 */
export async function action({ request }: Route.ActionArgs) {
  const parsed = await authenticateFormRequest(request);
  if ("error" in parsed) return parsed.error;
  const { form, client } = parsed;
  const token = form.get("token") ?? "";
  const row = await findOAuthToken(hashToken(token));
  // Only tokens belonging to this client are revoked. RFC 7009 §2.1 scopes
  // the cascade: revoking a REFRESH token should also invalidate the access
  // tokens issued alongside it, while revoking an access token leaves the
  // refresh grant alone, so a client that re-authorizes is not forced back
  // through the browser.
  if (row && row.clientId === client.id) {
    if (row.type === "refresh" && row.familyId) {
      await revokeOAuthTokenFamily(row.familyId);
    } else {
      await revokeOAuthToken(row.tokenHash);
    }
  }
  return new Response(null, { status: 200 });
}
