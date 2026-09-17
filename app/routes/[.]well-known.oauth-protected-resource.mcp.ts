import { protectedResourceMetadataResponse } from "~/lib/oauth.server";
import type { Route } from "./+types/[.]well-known.oauth-protected-resource.mcp";

/**
 * GET /.well-known/oauth-protected-resource/mcp: the path-aware RFC 9728
 * metadata URL for the MCP endpoint. RFC 9728 §3.1 puts a resource's
 * metadata between the origin and the resource's path, every MCP SDK probes
 * this URL before the origin-level one, and the /mcp 401's WWW-Authenticate
 * hint points here.
 */
export async function loader({ request }: Route.LoaderArgs) {
  return protectedResourceMetadataResponse(request);
}
