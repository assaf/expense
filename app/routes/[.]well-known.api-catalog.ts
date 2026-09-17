import { apiCatalogResponse } from "~/lib/mcp-discovery.server";
import type { Route } from "./+types/[.]well-known.api-catalog";

/**
 * GET /.well-known/api-catalog: the RFC 9727 API catalog, a linkset listing
 * the service's public APIs and pointing at their machine-readable
 * descriptions. One entry: the MCP endpoint, described by its Server Card.
 * Public by design, like the other .well-known documents.
 */
export function loader({ request }: Route.LoaderArgs): Response {
  return apiCatalogResponse(request);
}
