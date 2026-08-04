import type { Route } from "./+types/[.]well-known.oauth-protected-resource";

/**
 * GET /.well-known/oauth-protected-resource — RFC 9728 protected resource
 * metadata. Advertised in the WWW-Authenticate header of /mcp 401s so
 * clients can discover the authorization server (same origin here).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  return Response.json(
    {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
