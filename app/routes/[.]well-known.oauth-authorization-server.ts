import { oauthMetadataResponse } from "~/lib/oauth.server";
import type { Route } from "./+types/[.]well-known.oauth-authorization-server";

/**
 * GET /.well-known/oauth-authorization-server: RFC 8414 metadata for the MCP
 * authorization server. MCP clients (Claude, OpenAI, etc) fetch this to
 * discover the register/authorize/token/revoke endpoints before connecting to
 * /mcp.
 */
export async function loader({ request }: Route.LoaderArgs) {
  return oauthMetadataResponse(request);
}
