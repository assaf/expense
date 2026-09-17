import { protectedResourceMetadataResponse } from "~/lib/oauth.server";
import type { Route } from "./+types/[.]well-known.oauth-protected-resource";

/**
 * GET /.well-known/oauth-protected-resource: RFC 9728 protected resource
 * metadata, advertised in the WWW-Authenticate header of /mcp 401s so
 * clients can discover the authorization server (same origin here). MCP SDK
 * clients probe the path-aware variant (the sibling route) first; this
 * origin-level copy is the fallback for clients that only know the origin,
 * so it describes the same MCP endpoint.
 */
export async function loader({ request }: Route.LoaderArgs) {
  return protectedResourceMetadataResponse(request);
}
