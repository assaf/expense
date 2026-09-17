import { createHash } from "node:crypto";
import { MCP_ENDPOINT, SITE_URL } from "~/lib/seo-content";

/**
 * What an agent fetches before it connects: the MCP Server Card, the AI
 * Catalog that lists it, and the API catalog that describes the endpoint.
 *
 * Four documents, all built from one identity:
 *
 * - `/mcp/server-card` is the card at the location the Server Card extension
 *   reserves for a streamable-HTTP endpoint
 *   (github.com/modelcontextprotocol/ext-server-card).
 * - `/.well-known/mcp/server-card.json` is the same identity in the older
 *   SEP-1649 shape, which is the only card path scanners and shipped clients
 *   actually probe. Two shapes, one set of constants.
 * - `/.well-known/ai-catalog.json` is the catalog: the domain-level entry
 *   point that carries the card's exact URL.
 * - `/.well-known/api-catalog` is the RFC 9727 linkset, pointing at the card
 *   as the endpoint's machine-readable description.
 *
 * The identity declared here also drives the runtime `serverInfo`
 * (app/lib/mcp.server.ts), so the card and the live server/discover result
 * cannot contradict each other. The extension's wire format is still moving,
 * which is why every path, field, and literal lives in this one module.
 *
 * Not here, deliberately: an `mcp://server-card.json` MCP resource (removed
 * from the spec as useless for pre-connection discovery) and any tool or
 * resource listing (primitives stay runtime-listed; app/lib/mcp.server.ts is
 * their only home).
 */

/** Reverse-DNS server name; matches server.json's `name`, and satisfies the
 * card's ^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$ pattern. */
export const MCP_SERVER_NAME = "org.labnotes/expense";

export const MCP_SERVER_TITLE = "Expense";

/** Matches server.json's `version`. */
export const MCP_SERVER_VERSION = "1.0.0";

/** 96 characters; the schema caps a card description at 100. */
export const MCP_SERVER_DESCRIPTION =
  "Personal expense tracker. Capture receipts, log mileage at IRS rates, reconcile bank statements.";

/** The schema asks for setup instructions, and /connect is that page. */
export const MCP_SERVER_WEBSITE_URL = `${SITE_URL}/connect`;

/**
 * Protocol revisions this endpoint accepts, newest first: the modern leg
 * (`createMcpHandler` serves 2026-07-28 stateless clients) plus the five
 * legacy revisions the hand-wired 2025-era leg negotiates via `initialize`.
 * The SDK does export SUPPORTED_PROTOCOL_VERSIONS, but that is the
 * legacy-only list (its LATEST_PROTOCOL_VERSION is 2025-11-25) and the
 * legacy transport here passes no override, so importing it would both pull
 * the whole MCP SDK into this document's bundle and omit the modern
 * revision. Literal, in one place, set against the SDK's default list.
 */
export const MCP_PROTOCOL_VERSIONS = [
  "2026-07-28", // the modern leg, served by createMcpHandler
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07", // the legacy leg, negotiated by the SDK's default list
];

/** The location the extension reserves for a card: GET <streamable-http-url>/server-card. */
const SERVER_CARD_PATH = "/server-card";

export const SERVER_CARD_URL = `${MCP_ENDPOINT}${SERVER_CARD_PATH}`;

export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";

export const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";

/** RFC 9727 fixes this one: `application/json` there fails silently. */
export const LINKSET_MEDIA_TYPE = "application/linkset+json";

/**
 * The card: identity and connection details only. No `repository` field (the
 * GitHub remote is private, and a dead link in a public card is worse than an
 * omitted optional field), no `authentication` field (the extension does not
 * model auth yet; clients learn OAuth from the 401's RFC 9728
 * WWW-Authenticate hint), and no primitives: tools and resources stay
 * runtime-listed, with the tool list's single home in app/lib/mcp.server.ts
 * (its 13 names pinned by test/mcp.test.ts, and copied for the /connect page
 * in app/data/connect.yaml).
 */
const SERVER_CARD = {
  $schema:
    "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  name: MCP_SERVER_NAME,
  title: MCP_SERVER_TITLE,
  version: MCP_SERVER_VERSION,
  description: MCP_SERVER_DESCRIPTION,
  websiteUrl: MCP_SERVER_WEBSITE_URL,
  icons: [
    {
      src: `${SITE_URL}/logo-icon-32.png`,
      mimeType: "image/png",
      sizes: ["32x32"],
    },
    {
      src: `${SITE_URL}/logo-icon-192.png`,
      mimeType: "image/png",
      sizes: ["192x192"],
    },
    {
      src: `${SITE_URL}/logo-icon-512.png`,
      mimeType: "image/png",
      sizes: ["512x512"],
    },
  ],
  remotes: [
    {
      type: "streamable-http",
      url: MCP_ENDPOINT,
      supportedProtocolVersions: MCP_PROTOCOL_VERSIONS,
    },
  ],
};

/**
 * The catalog: the entry point for domain-level discovery, listing this
 * domain's cards. Two specs describe it and they disagree in places, so this
 * follows the stricter one and stays legal under both. From the extension's
 * discovery doc: `specVersion` names the ai-catalog data model (1.0, not the
 * ARD spec's own version) and the entry identifier follows
 * urn:air:{publisher}:{namespace}:{name}, matching the card name's
 * org.labnotes. From the ARD spec: a `host` block and an entry `displayName`,
 * which the extension says may be omitted when the card carries its own
 * title. `representativeQueries` are the tasks the server actually answers,
 * for registries that build embeddings from the catalog.
 */
const AI_CATALOG = {
  specVersion: "1.0",
  host: {
    displayName: MCP_SERVER_TITLE,
    identifier: SITE_URL,
  },
  entries: [
    {
      identifier: "urn:air:labnotes.org:mcp:expense",
      displayName: MCP_SERVER_TITLE,
      type: SERVER_CARD_MEDIA_TYPE,
      url: SERVER_CARD_URL,
      representativeQueries: [
        "how much did I spend on flights last quarter",
        "capture this receipt photo as an expense",
        "log a drive to the client office and price it at the IRS rate",
      ],
    },
  ],
};

/**
 * The same identity in the shape SEP-1649 documented, at the well-known path
 * scanners and shipped clients have probed since 2025. That SEP is closed and
 * the current card lives in the extension (see SERVER_CARD above), but this
 * path is the one a scanner actually fetches, so it stays served. The fields
 * follow the SEP's list rather than the looser shape the scorecard accepts:
 * `$schema` and `version` (the card-schema version, not the server's),
 * `protocolVersion` (the modern revision; the extension card carries the full
 * list), `serverInfo`, `transport.endpoint`, `capabilities`, and an
 * `authentication` object. Tools are declared as the reserved `["dynamic"]`
 * value, which is how the SEP says "discover these over the protocol" - a
 * second copy of the names here would drift from app/lib/mcp.server.ts.
 */
const WELL_KNOWN_SERVER_CARD = {
  $schema:
    "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
  version: "1.0",
  protocolVersion: MCP_PROTOCOL_VERSIONS[0],
  serverInfo: {
    name: MCP_SERVER_NAME,
    title: MCP_SERVER_TITLE,
    version: MCP_SERVER_VERSION,
    description: MCP_SERVER_DESCRIPTION,
  },
  documentationUrl: MCP_SERVER_WEBSITE_URL,
  transport: { type: "streamable-http", endpoint: MCP_ENDPOINT },
  capabilities: { tools: {} },
  authentication: { required: true, schemes: ["oauth2"] },
  tools: ["dynamic"],
};

/**
 * The RFC 9727 catalog: one linkset entry per public API. The MCP endpoint is
 * the only public API this service has (the app's own routes are
 * session-gated, and /api/webmcp mirrors the read tools only behind that
 * session), so there is one anchor, described by the Server Card. Written in
 * the RFC's own "link context object" form (Appendix A.1), not the `links`
 * array form some examples use.
 */
const API_CATALOG = {
  linkset: [
    {
      anchor: MCP_ENDPOINT,
      "service-desc": [{ href: SERVER_CARD_URL, type: SERVER_CARD_MEDIA_TYPE }],
      "service-doc": [
        { href: `${SITE_URL}/connect.md`, type: "text/markdown" },
      ],
    },
  ],
};

/** Serialized once, so the tag always matches the exact bytes served. */
const SERVER_CARD_BODY = JSON.stringify(SERVER_CARD, null, 2) + "\n";

const SERVER_CARD_ETAG = `"${createHash("sha256").update(SERVER_CARD_BODY).digest("base64url").slice(0, 32)}"`;

const AI_CATALOG_BODY = JSON.stringify(AI_CATALOG, null, 2) + "\n";

const AI_CATALOG_ETAG = `"${createHash("sha256").update(AI_CATALOG_BODY).digest("base64url").slice(0, 32)}"`;

const WELL_KNOWN_SERVER_CARD_BODY =
  JSON.stringify(WELL_KNOWN_SERVER_CARD, null, 2) + "\n";

const WELL_KNOWN_SERVER_CARD_ETAG = `"${createHash("sha256").update(WELL_KNOWN_SERVER_CARD_BODY).digest("base64url").slice(0, 32)}"`;

const API_CATALOG_BODY = JSON.stringify(API_CATALOG, null, 2) + "\n";

const API_CATALOG_ETAG = `"${createHash("sha256").update(API_CATALOG_BODY).digest("base64url").slice(0, 32)}"`;

/** RFC 9110 If-None-Match: `*`, or a comma-separated list compared weakly
 * (the `W/` prefix ignored). */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//, "") === etag;
  });
}

/** A GET-only public document: the CORS set the extension requires, an hour
 * of caching, and an ETag honored on the next request. One representation per
 * path, so `Content-Type` ignores the request's `Accept`. */
function cachedJsonResponse(
  request: Request,
  body: string,
  etag: string,
  contentType: string,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
    "Access-Control-Expose-Headers": "ETag",
    ETag: etag,
  };
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

/** 200 the Server Card, or 304 when the client's ETag is current. */
export function serverCardResponse(request: Request): Response {
  return cachedJsonResponse(
    request,
    SERVER_CARD_BODY,
    SERVER_CARD_ETAG,
    SERVER_CARD_MEDIA_TYPE,
  );
}

/** 200 the AI Catalog, or 304 when the client's ETag is current. */
export function aiCatalogResponse(request: Request): Response {
  return cachedJsonResponse(
    request,
    AI_CATALOG_BODY,
    AI_CATALOG_ETAG,
    AI_CATALOG_MEDIA_TYPE,
  );
}

/** 200 the SEP-1649 card at /.well-known/mcp/server-card.json. Plain
 * `application/json`: the older shape never had a media type of its own. */
export function wellKnownServerCardResponse(request: Request): Response {
  return cachedJsonResponse(
    request,
    WELL_KNOWN_SERVER_CARD_BODY,
    WELL_KNOWN_SERVER_CARD_ETAG,
    "application/json",
  );
}

/** 200 the RFC 9727 API catalog at /.well-known/api-catalog. */
export function apiCatalogResponse(request: Request): Response {
  return cachedJsonResponse(
    request,
    API_CATALOG_BODY,
    API_CATALOG_ETAG,
    LINKSET_MEDIA_TYPE,
  );
}
