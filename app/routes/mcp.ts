import { handleMcpRequest } from "~/lib/mcp.server";
import type { Route } from "./+types/mcp";

/**
 * /mcp — the MCP (Model Context Protocol) Streamable HTTP endpoint.
 *
 * Point any MCP client (Claude Code, Claude Desktop, Cursor, …) here with an
 * API token from Settings → Agents & API as the bearer token:
 *
 *   { "mcpServers": { "expense": {
 *       "type": "http",
 *       "url": "https://<host>/mcp",
 *       "headers": { "Authorization": "Bearer exp_…" }
 *     } } }
 *
 * Auth is per-request (bearer token → account). Sessions are created on the
 * initialize handshake and bound to the token's account + capabilities;
 * every subsequent request must present a token for the same account.
 */
export const config = { maxDuration: 60 };

export async function loader({ request }: Route.LoaderArgs) {
  return handleMcpRequest(request);
}

export async function action({ request }: Route.ActionArgs) {
  return handleMcpRequest(request);
}
