import { serverCardResponse } from "~/lib/mcp-discovery.server";
import type { Route } from "./+types/mcp.server-card";

/**
 * GET /mcp/server-card: the MCP Server Card, the location the Server Card
 * extension reserves for the streamable-HTTP endpoint's card
 * (<streamable-http-url>/server-card). A resource route, so it bypasses the
 * root loader's auth gate and is readable before a client connects by
 * design. The document itself (identity, transports, caching) lives in
 * app/lib/mcp-discovery.server.ts, the AI Catalog points here, and /mcp
 * serves the protocol.
 */
export function loader({ request }: Route.LoaderArgs): Response {
  return serverCardResponse(request);
}
