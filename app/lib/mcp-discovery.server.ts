import { createHash } from "node:crypto";
import { MCP_ENDPOINT, SITE_URL } from "~/lib/seo-content";

/**
 * Pre-connection discovery for the MCP server: the Server Card served at
 * /mcp/server-card and the AI Catalog at /.well-known/ai-catalog.json.
 *
 * A client reads both before it connects, so the identity declared here also
 * drives the runtime `serverInfo` (app/lib/mcp.server.ts): the card and the
 * live server/discover result must not contradict each other. The shape is
 * the experimental Server Card extension
 * (github.com/modelcontextprotocol/ext-server-card), whose wire format is
 * still moving, so every path, field, and literal lives in this one module.
 *
 * Two placements the spec allows but this app does not use, so nobody moves
 * these back: a card under /.well-known (not recommended — .well-known is
 * site-wide metadata while a card is application-level, and the catalog
 * already carries the card's exact URL) and an `mcp://server-card.json` MCP
 * resource (removed from the spec as useless for pre-connection discovery).
 * /.well-known stays right for the catalog itself.
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
 * domain's cards. The identifier follows urn:air:{publisher}:{namespace}:{name},
 * with the publisher domain and namespace matching the card name's
 * org.labnotes. No `host` object (optional, and it would mean inventing
 * operator copy no content file carries) and no entry displayName/description
 * (the spec says to omit them when the referenced card carries its own title
 * and description, as this one does).
 */
const AI_CATALOG = {
  specVersion: "1.0",
  entries: [
    {
      identifier: "urn:air:labnotes.org:mcp:expense",
      type: SERVER_CARD_MEDIA_TYPE,
      url: SERVER_CARD_URL,
    },
  ],
};

/** Serialized once, so the tag always matches the exact bytes served. */
const SERVER_CARD_BODY = JSON.stringify(SERVER_CARD, null, 2) + "\n";

const SERVER_CARD_ETAG = `"${createHash("sha256").update(SERVER_CARD_BODY).digest("base64url").slice(0, 32)}"`;

const AI_CATALOG_BODY = JSON.stringify(AI_CATALOG, null, 2) + "\n";

const AI_CATALOG_ETAG = `"${createHash("sha256").update(AI_CATALOG_BODY).digest("base64url").slice(0, 32)}"`;

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
