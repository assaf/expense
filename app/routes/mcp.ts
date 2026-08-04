import { handleMcpRequest } from "~/lib/mcp.server";
import type { Route } from "./+types/mcp";

/**
 * /mcp — the MCP (Model Context Protocol) Streamable HTTP endpoint.
 *
 * Point any MCP client (Claude Code, Claude Desktop, Cursor, …) here — the
 * client discovers the OAuth flow (/.well-known/oauth-authorization-server)
 * and you approve the connection by signing in. No API keys:
 *
 *   { "mcpServers": { "expense": {
 *       "type": "http",
 *       "url": "https://<host>/mcp"
 *     } } }
 *
 * Auth is per-request (OAuth access token → account). Sessions are created
 * on the initialize handshake and bound to the token's account; every
 * subsequent request must present a token for the same account.
 */
export const config = { maxDuration: 60 };

export async function loader({ request }: Route.LoaderArgs) {
  return handleMcpRequest(request);
}

export async function action({ request }: Route.ActionArgs) {
  return handleMcpRequest(request);
}
