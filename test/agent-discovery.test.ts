import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  MCP_ENDPOINT,
  SITE_URL,
  marketingPageHeaders,
} from "~/lib/seo-content";
import {
  AI_CATALOG_MEDIA_TYPE,
  LINKSET_MEDIA_TYPE,
  MCP_PROTOCOL_VERSIONS,
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_URL,
  aiCatalogResponse,
  apiCatalogResponse,
  serverCardResponse,
  wellKnownServerCardResponse,
} from "~/lib/mcp-discovery.server";
import { loader as authLoader } from "~/routes/auth[.]md";
import { headers, loader as rootLoader } from "~/root";
import { contextForRequest } from "./helpers/authContext";

/**
 * What an agent fetches before it connects, as the agent sees it: the two
 * cards, the catalogs, the auth document, and the pointers that lead to them.
 * None of it involves a session, and every URL these documents advertise has
 * to resolve, so the assertions here are about what a client observes rather
 * than about the constants they are built from.
 */

const CARD_URL = `${MCP_ENDPOINT}/server-card`;

const CATALOG_URL = `${SITE_URL}/.well-known/ai-catalog.json`;

const WELL_KNOWN_CARD_URL = `${SITE_URL}/.well-known/mcp/server-card.json`;

const API_CATALOG_URL = `${SITE_URL}/.well-known/api-catalog`;

const card = (init?: RequestInit) =>
  serverCardResponse(new Request(CARD_URL, init));

const catalog = (init?: RequestInit) =>
  aiCatalogResponse(new Request(CATALOG_URL, init));

const wellKnownCard = (init?: RequestInit) =>
  wellKnownServerCardResponse(new Request(WELL_KNOWN_CARD_URL, init));

const apiCatalog = (init?: RequestInit) =>
  apiCatalogResponse(new Request(API_CATALOG_URL, init));

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

/** The root loader throws its redirects (React Router's contract), so this
 * returns the thrown Response or null when the request resolved to loader
 * data. */
async function thrownResponse(
  path: string,
  accept: string,
  method = "GET",
): Promise<Response | null> {
  const request = new Request(`https://expense.test${path}`, {
    method,
    headers: { Accept: accept },
  });
  const thrown = await rootLoader({
    request,
    params: {},
    context: await contextForRequest(request),
  } as unknown as Parameters<typeof rootLoader>[0]).then(
    () => null,
    (error: unknown) => error,
  );
  if (thrown === null) return null;
  if (!(thrown instanceof Response)) throw new Error("not a Response");
  return thrown;
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
    // description within its 100-character cap, and a version that is not a
    // range.
    expect(body.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(body.description.length).toBeGreaterThan(0);
    expect(body.description.length).toBeLessThanOrEqual(100);
    expect(body.version).not.toMatch(/[\^~><=*]/);
  });

  it("serves the SEP-1649 card where scanners and shipped clients look", async () => {
    const response = wellKnownCard();
    expect(response.status).toBe(200);
    expectDiscoveryHeaders(response, "application/json");

    const body = JSON.parse(await response.text());
    // The SEP's required fields: the card schema it conforms to, the card
    // schema version (not the server's), the protocol revision, identity,
    // transport, and capabilities.
    expect(body.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
    );
    expect(body.version).toBe("1.0");
    expect(body.protocolVersion).toBe("2026-07-28");
    expect(body.serverInfo.name).toBe("org.labnotes/expense");
    expect(body.serverInfo.title).toBe("Expense");
    expect(body.serverInfo.version).toBe("1.0.0");
    expect(body.serverInfo.description.length).toBeGreaterThan(0);
    expect(body.transport).toEqual({
      type: "streamable-http",
      endpoint: MCP_ENDPOINT,
    });
    expect(body.authentication).toEqual({
      required: true,
      schemes: ["oauth2"],
    });
    // Capabilities are declared; the tools themselves are marked dynamic, the
    // SEP's way of saying "list them over the protocol". Their names live in
    // app/lib/mcp.server.ts and a copy here would drift.
    expect(body.capabilities).toEqual({ tools: {} });
    expect(body.tools).toEqual(["dynamic"]);
    // Same identity as the reserved-path card, so the two cannot disagree.
    const canonical = JSON.parse(await card().text());
    expect(body.serverInfo.name).toBe(canonical.name);
    expect(body.serverInfo.version).toBe(canonical.version);
    expect(body.serverInfo.title).toBe(canonical.title);
    expect(body.transport.endpoint).toBe(canonical.remotes[0].url);
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

  it("revalidates the other three documents too", async () => {
    for (const [make, type] of [
      [catalog, AI_CATALOG_MEDIA_TYPE],
      [wellKnownCard, "application/json"],
      [apiCatalog, LINKSET_MEDIA_TYPE],
    ] as const) {
      const etag = expectDiscoveryHeaders(make(), type);
      expect(etag).not.toBe("");
      const revalidated = make({ headers: { "If-None-Match": etag } });
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe("");
    }
  });
});

describe("AI Catalog", () => {
  it("advertises the card under its own media type", async () => {
    const response = catalog();
    expect(response.status).toBe(200);
    expectDiscoveryHeaders(response, AI_CATALOG_MEDIA_TYPE);

    const body = JSON.parse(await response.text());
    expect(body.specVersion).toBe("1.0");
    expect(body.host.displayName.trim()).not.toBe("");
    expect(body.host.identifier).toBe(SITE_URL);
    expect(body.entries.length).toBe(1);
    const entry = body.entries[0];
    expect(entry.identifier).toBe("urn:air:labnotes.org:mcp:expense");
    expect(entry.displayName).toBe("Expense");
    expect(entry.type).toBe(SERVER_CARD_MEDIA_TYPE);
    expect(entry.url).toBe(SERVER_CARD_URL);
    // Registries build embeddings from these, so they have to describe real
    // work: at least two, all non-empty.
    expect(entry.representativeQueries.length).toBeGreaterThanOrEqual(2);
    for (const query of entry.representativeQueries as string[]) {
      expect(query.trim().length).toBeGreaterThan(10);
    }
    // Exactly one of url or data, never both (spec §3.4).
    expect("data" in entry).toBe(false);
  });
});

describe("API Catalog", () => {
  it("describes the MCP endpoint with the media type RFC 9727 requires", async () => {
    const response = apiCatalog();
    expect(response.status).toBe(200);
    // application/json here fails silently, which is why it is pinned.
    expectDiscoveryHeaders(response, LINKSET_MEDIA_TYPE);

    const body = JSON.parse(await response.text());
    expect(body.linkset).toEqual([
      {
        anchor: MCP_ENDPOINT,
        "service-desc": [
          { href: SERVER_CARD_URL, type: SERVER_CARD_MEDIA_TYPE },
        ],
        "service-doc": [
          { href: `${SITE_URL}/connect.md`, type: "text/markdown" },
        ],
      },
    ]);
  });
});

describe("discovery pointers", () => {
  it("advertises the catalog, the card, and the LLM overview in the headers", () => {
    const link = new Headers(headers()).get("Link") ?? "";
    const byRel: Record<string, string> = {};
    for (const match of link.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/g)) {
      byRel[match[2]!] = match[1]!;
    }
    expect(byRel).toEqual({
      "api-catalog": "/.well-known/api-catalog",
      "service-desc": "/mcp/server-card",
      describedby: "/llms.txt",
    });
    // Nothing here is negotiated: a URL has one representation, so no Vary
    // at all (a cache that does not understand it serves the wrong body).
    expect(new Headers(headers()).get("Vary")).toBeNull();
    // The root's generic header names no mirror: it is served on pages
    // without one (the app, /login).
    expect(link).not.toContain("alternate");
    // A marketing page's own headers replace the root's, so they carry the
    // links, the framing defense, and their own mirror (llms.txt v2 asks for
    // `rel="alternate"` on the page that has one).
    const marketing = new Headers(marketingPageHeaders("/about.md"));
    expect(marketing.get("Link")).toContain('rel="api-catalog"');
    expect(marketing.get("Link")).toContain(
      '</about.md>; rel="alternate"; type="text/markdown"',
    );
    expect(marketing.get("Vary")).toBeNull();
    expect(marketing.get("X-Frame-Options")).toBe("DENY");
  });

  it("declares Content Signals and the catalog in robots.txt", () => {
    const robots = readFileSync(
      new URL("../public/robots.txt", import.meta.url),
      "utf8",
    );
    // The directive only counts inside a User-agent block, so it is read from
    // the wildcard block rather than the file as a whole.
    const block = robots
      .split(/\n(?=User-agent:)/)
      .find((section) => section.startsWith("User-agent: *"));
    expect(block).toContain(
      "Content-Signal: ai-train=yes, search=yes, ai-input=yes",
    );
    expect(robots).toContain(`Agentmap: ${CATALOG_URL}`);
  });

  it("serves the agent auth document at /auth.md", async () => {
    const response = await authLoader();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    const body = await response.text();
    // The Auth.md convention: an H1 naming the file. The rest is the
    // discovery trail an agent needs, with placeholders filled in.
    expect(body.split("\n")[0]).toBe("# auth.md");
    expect(body).toContain(
      `${SITE_URL}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(body).toContain(MCP_ENDPOINT);
    expect(body).not.toContain("{{");
  });
});

describe("no content negotiation on Accept", () => {
  // A URL has exactly one representation. Serving a different one per Accept
  // (a mirror redirect, an HTML landing page) means a shared cache has to
  // understand Vary to get it right, and the ones that do not serve the wrong
  // body to the next client. The `.md` mirrors are still their own URLs,
  // advertised by rel="alternate" and by llms.txt.
  it("never redirects a markdown-preferring client to the mirror", async () => {
    for (const accept of [
      "text/markdown",
      "text/markdown;q=0.9, text/html;q=0.1",
      "text/html,application/xhtml+xml",
      "*/*",
    ]) {
      expect(await thrownResponse("/about", accept)).toBeNull();
      expect(await thrownResponse("/faq", accept)).toBeNull();
    }
  });

  it("keeps the mirrors reachable as their own URLs", () => {
    // The negotiation is gone, the mirrors are not: they are resource routes
    // beside the page, and the page still advertises one.
    const marketing = new Headers(marketingPageHeaders("/about.md"));
    expect(marketing.get("Link")).toContain(
      '</about.md>; rel="alternate"; type="text/markdown"',
    );
  });
});
