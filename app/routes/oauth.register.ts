import { randomBytes } from "node:crypto";
import { buildRegisteredClient } from "~/lib/oauth.server";
import { registerOAuthClient } from "~/lib/store.server";
import type { Route } from "./+types/oauth.register";

/**
 * GET /oauth/register — not a valid endpoint. RFC 7591 only defines POST
 * for client registration. Return 405 so React Router doesn't throw
 * getInternalRouterError.
 */
export function loader(): Response {
  return new Response("Method Not Allowed", { status: 405 });
}

/**
 * POST /oauth/register — dynamic client registration (RFC 7591). MCP clients
 * call this once and keep the returned client_id; the response includes a
 * client_secret only for `client_secret_basic` (confidential) registrations.
 * PKCE clients register with `token_endpoint_auth_method: "none"`.
 */
export async function action({ request }: Route.ActionArgs) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return registrationError("The request body must be a JSON object.");
  }
  const meta =
    typeof body === "object" && body !== null
      ? (body as {
          client_name?: unknown;
          redirect_uris?: unknown;
          token_endpoint_auth_method?: unknown;
        })
      : {};

  const redirectUris = Array.isArray(meta.redirect_uris)
    ? meta.redirect_uris.filter((uri): uri is string => typeof uri === "string")
    : [];
  if (!Array.isArray(meta.redirect_uris)) {
    return registrationError("redirect_uris must be an array of strings.");
  }

  const authMethod =
    meta.token_endpoint_auth_method === "client_secret_basic"
      ? "client_secret_basic"
      : "none";

  const built = buildRegisteredClient({
    clientId: `client_${randomBytes(16).toString("base64url")}`,
    name: typeof meta.client_name === "string" ? meta.client_name : "",
    redirectUris,
    authMethod,
  });
  if (built.error || !built.client) {
    return registrationError(built.error ?? "Invalid client metadata.");
  }

  const client = await registerOAuthClient({
    id: built.client.id,
    secretHash: built.client.secretHash,
    name: built.client.name,
    redirectUris: built.client.redirectUris,
    authMethod: built.client.authMethod,
  });

  return Response.json({
    client_id: client.id,
    ...(built.secret ? { client_secret: built.secret } : {}),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: client.authMethod,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
  });
}

function registrationError(description: string): Response {
  return Response.json(
    { error: "invalid_client_metadata", error_description: description },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
