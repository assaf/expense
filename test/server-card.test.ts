import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_ENDPOINT, SITE_URL } from "~/lib/seo-content";
import {
  AI_CATALOG_MEDIA_TYPE,
  MCP_PROTOCOL_VERSIONS,
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_URL,
  aiCatalogResponse,
  serverCardResponse,
} from "~/lib/mcp-discovery.server";

/**
 * The two pre-connection discovery documents, as a client sees them: the
 * card's identity and connection details, the catalog pointing at the card
 * URL, the CORS/cache/ETag headers the extension requires, and the registry
 * manifest the same identity is published to. Nothing here involves a
 * session: both documents are public by design.
 */

const CARD_URL = `${MCP_ENDPOINT}/server-card`;

const CATALOG_URL = `${SITE_URL}/.well-known/ai-catalog.json`;

const card = (init?: RequestInit) =>
  serverCardResponse(new Request(CARD_URL, init));

const catalog = (init?: RequestInit) =>
  aiCatalogResponse(new Request(CATALOG_URL, init));

/** The headers these responses carry on 200 and on 304 alike; returns the tag
 * for the follow-up revalidation. */
function expectDiscoveryHeaders(response: Response, contentType: string) {
  expect(response.headers.get("content-type")).toBe(contentType);
  expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-methods")).toBe("GET");
  expect(response.headers.get("access-control-allow-headers")).toBe(
    "Content-Type, If-None-Match",
  );
  expect(response.headers.get("access-control-expose-headers")).toBe("ETag");
  expect(response.headers.get("etag")).toMatch(/^".+"$/);
  return response.headers.get("etag") ?? "";
}

describe("MCP Server Card", () => {
  it("serves the card's identity and transport at the reserved path", async () => {
    const response = card();
    expect(response.status).toBe(200);
    expectDiscoveryHeaders(response, SERVER_CARD_MEDIA_TYPE);

    const body = JSON.parse(await response.text());
    expect(body.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    );
    expect(body.name).toBe("org.labnotes/expense");
    expect(body.title).toBe("Expense");
    expect(body.version).toBe("1.0.0");
    expect(body.websiteUrl).toBe(`${SITE_URL}/connect`);
    expect(body.remotes).toEqual([
      {
        type: "streamable-http",
        url: MCP_ENDPOINT,
        supportedProtocolVersions: MCP_PROTOCOL_VERSIONS,
      },
    ]);
    // Icons are served from this site, at the sizes the card claims.
    expect(body.icons).toEqual([
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
    ]);
  });

  it("stays inside the schema's limits", async () => {
    const body = JSON.parse(await card().text());
    // What a validating client checks: the name pattern, a non-empty
    // description within its 100-character cap, and a version string that is
    // not a range.
    expect(body.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(body.description.length).toBeGreaterThan(0);
    expect(body.description.length).toBeLessThanOrEqual(100);
    expect(body.version).not.toMatch(/[\^~><=*]/);
  });

  it("advertises the revisions the endpoint actually serves", async () => {
    // The modern leg serves the 2026-07-28 revision natively; the legacy leg
    // negotiates the SDK's own default list, so the two lists must agree.
    const sdk = await import("@modelcontextprotocol/server");
    expect(MCP_PROTOCOL_VERSIONS[0]).toBe("2026-07-28");
    expect(MCP_PROTOCOL_VERSIONS.slice(1)).toEqual(
      sdk.SUPPORTED_PROTOCOL_VERSIONS,
    );
  });

  it("revalidates with If-None-Match instead of resending the body", async () => {
    const etag = expectDiscoveryHeaders(card(), SERVER_CARD_MEDIA_TYPE);
    expect(etag).not.toBe("");

    const revalidated = card({ headers: { "If-None-Match": etag } });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(revalidated.headers.get("access-control-allow-origin")).toBe("*");

    // Weak comparison, and the `*` wildcard; a different tag still gets 200.
    expect(card({ headers: { "If-None-Match": `W/${etag}` } }).status).toBe(
      304,
    );
    expect(card({ headers: { "If-None-Match": "*" } }).status).toBe(304);
    expect(card({ headers: { "If-None-Match": '"nope"' } }).status).toBe(200);
  });
});

describe("AI Catalog", () => {
  it("advertises the card under its own media type", async () => {
    const response = catalog();
    expect(response.status).toBe(200);
    expectDiscoveryHeaders(response, AI_CATALOG_MEDIA_TYPE);

    const body = JSON.parse(await response.text());
    expect(body.specVersion).toBe("1.0");
    expect(body.entries).toEqual([
      {
        identifier: "urn:air:labnotes.org:mcp:expense",
        type: SERVER_CARD_MEDIA_TYPE,
        url: SERVER_CARD_URL,
      },
    ]);
  });

  it("revalidates with If-None-Match instead of resending the body", async () => {
    const etag = expectDiscoveryHeaders(catalog(), AI_CATALOG_MEDIA_TYPE);
    expect(etag).not.toBe("");

    const revalidated = catalog({ headers: { "If-None-Match": etag } });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
    expect(catalog().status).toBe(200);
  });
});

describe("discovery identity", () => {
  it("matches the registry manifest, so card and registry cannot drift", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../server.json", import.meta.url), "utf8"),
    ) as {
      name: string;
      title: string;
      version: string;
      remotes: Array<{ url: string }>;
    };
    const body = JSON.parse(await card().text());
    expect(manifest.name).toBe(body.name);
    expect(manifest.title).toBe(body.title);
    expect(manifest.version).toBe(body.version);
    expect(manifest.remotes.map((remote) => remote.url)).toEqual([
      MCP_ENDPOINT,
    ]);
    // The catalog's url is the endpoint's card, not the domain root's.
    expect(SERVER_CARD_URL).toBe(`${MCP_ENDPOINT}/server-card`);
  });
});
