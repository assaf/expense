import { aiCatalogResponse } from "~/lib/mcp-discovery.server";
import type { Route } from "./+types/[.]well-known.ai-catalog[.]json";

/**
 * GET /.well-known/ai-catalog.json: the AI Catalog, the domain-level
 * discovery entry point that lists this domain's MCP Server Card (the JSON
 * mirror of the card documented in app/lib/mcp-discovery.server.ts). Public
 * by design, like the other .well-known documents.
 */
export function loader({ request }: Route.LoaderArgs): Response {
  return aiCatalogResponse(request);
}
