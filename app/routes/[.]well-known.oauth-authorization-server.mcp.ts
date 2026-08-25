import { oauthMetadataResponse } from "~/lib/oauth.server";
import type { Route } from "./+types/[.]well-known.oauth-authorization-server.mcp";

/**
 * GET /.well-known/oauth-authorization-server/mcp: the path-aware RFC 8414
 * metadata URL. Newer MCP SDK clients probe this BEFORE the root endpoint
 * when the MCP server URL has a path (e.g. https://host/mcp): discovery
 * fails entirely without it ("Failed to discover OAuth metadata").
 */
export async function loader({ request }: Route.LoaderArgs) {
  return oauthMetadataResponse(request);
}
