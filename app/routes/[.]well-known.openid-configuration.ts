import { oauthMetadataResponse } from "~/lib/oauth.server";
import type { Route } from "./+types/[.]well-known.openid-configuration";

/**
 * GET /.well-known/openid-configuration: a mirror of the authorization
 * server metadata for clients that perform OAuth discovery there instead of
 * at the RFC 8414 endpoint.
 */
export async function loader({ request }: Route.LoaderArgs) {
  return oauthMetadataResponse(request);
}
