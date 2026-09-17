import { wellKnownServerCardResponse } from "~/lib/mcp-discovery.server";
import type { Route } from "./+types/[.]well-known.mcp.server-card[.]json";

/**
 * GET /.well-known/mcp/server-card.json: the MCP Server Card in the SEP-1649
 * shape at the path scanners and shipped clients probe. The current
 * extension reserves /mcp/server-card instead (see app/routes/mcp.server-card.ts)
 * and calls a card application-level metadata, but nothing looks there yet,
 * so both paths are served from the same identity constants.
 */
export function loader({ request }: Route.LoaderArgs): Response {
  return wellKnownServerCardResponse(request);
}
