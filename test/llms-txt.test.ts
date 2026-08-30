import { describe, expect, it } from "vitest";
import { loader } from "~/routes/llms[.]txt";
import { llmsTxt, SITE_URL } from "~/lib/seo-content";

/**
 * /llms.txt is how LLMs learn about the app (llmstxt.org convention), so
 * its contract is structural, not copy: the H1-first shape the convention
 * requires, machine-readable key facts, a documented MCP endpoint, and
 * links that resolve for a client that only has the raw text (absolute
 * https URLs, canonical domain). Headers matter for the same audience:
 * plain text with charset, cacheable like the other public mirrors.
 */

describe("GET /llms.txt", () => {
  it("serves text/plain with charset and the shared public cache header", async () => {
    const res = await loader();
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("serves the llmsTxt content verbatim", async () => {
    const res = await loader();
    await expect(res.text()).resolves.toBe(llmsTxt());
  });

  it("starts with an H1 title followed by a blockquote summary", () => {
    const text = llmsTxt();
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^# .+/);
    // The convention's optional summary: a blockquote line near the top.
    expect(lines.slice(0, 5).some((l) => l.startsWith("> "))).toBe(true);
  });

  it("lists machine-readable Name and URL key facts", () => {
    const text = llmsTxt();
    expect(text).toContain("Name: Expense");
    expect(text).toContain(`URL: ${SITE_URL}`);
  });

  it("documents the MCP endpoint", () => {
    // The primary integration surface for assistants; if the path moves,
    // this file must move with it.
    expect(llmsTxt()).toContain(`${SITE_URL}/mcp`);
  });

  it("only links absolute https URLs", () => {
    // A client that fetched /llms.txt by URL cannot resolve relative
    // links; every markdown link must be absolute https.
    const links = [...llmsTxt().matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)];
    expect(links.length).toBeGreaterThanOrEqual(5);
    for (const [, title, href] of links) {
      expect(title.trim()).not.toBe("");
      expect(href).toMatch(/^https:\/\//);
      expect(href).not.toMatch(/\s/);
    }
  });

  it("keeps every own-site link on the canonical domain", () => {
    // Canonical-URL discipline: mirrors of the marketing copy must not
    // drift onto staging or alternate hosts.
    const ownLinks = [
      ...llmsTxt().matchAll(/\[[^\]]+\]\((https:\/\/[^)\s]+)\)/g),
    ].map((m) => m[1]);
    for (const href of ownLinks) {
      expect(
        href.startsWith(`${SITE_URL}/`) ||
          href.startsWith("https://labnotes.org"),
        `${href} is off the canonical domains`,
      ).toBe(true);
    }
  });

  it("contains no placeholder or unfinished markers", () => {
    expect(llmsTxt()).not.toMatch(/\bTODO\b|\bFIXME\b|lorem ipsum/i);
  });
});
