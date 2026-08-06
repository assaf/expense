import { handleMcpRequest } from "~/lib/mcp.server";
import type { Route } from "./+types/mcp";

/**
 * /mcp — the MCP (Model Context Protocol) Streamable HTTP endpoint.
 *
 * Point any MCP client (Claude, OpenAI, etc.) here — the client discovers the
 * OAuth flow (/.well-known/oauth-authorization-server) and you approve the
 * connection by signing in. No API keys:
 *
 *   { "mcpServers": { "expense": {
 *       "type": "http",
 *       "url": "https://<host>/mcp"
 *     } } }
 *
 * Auth is per-request (OAuth access token → account). The endpoint serves
 * both protocol eras statelessly from one entry: 2025-era clients (the
 * `initialize` handshake) and 2026-07-28 stateless clients (a per-request
 * `_meta` envelope). Nothing is held between requests — no sessions.
 */
export const config = { maxDuration: 60 };

export async function loader({ request }: Route.LoaderArgs) {
  return handleMcpRequest(request);
}

export async function action({ request }: Route.ActionArgs) {
  return handleMcpRequest(request);
}
