import { describe, expect, it } from "vitest";
import { loader as aboutLoader } from "~/routes/about[.]md";
import { loader as alternativesLoader } from "~/routes/alternatives[.]md";
import { loader as connectLoader } from "~/routes/connect[.]md";
import { loader as faqLoader } from "~/routes/faq[.]md";
import { loader as llmsTxtLoader } from "~/routes/llms[.]txt";
import {
  aboutMarkdown,
  alternativesMarkdown,
  connectMarkdown,
  faqMarkdown,
  llmsTxt,
  SITE_URL,
} from "~/lib/seo-content";

/** The five public text mirrors (llmstxt.org convention) and their
 * routes. The loader wiring is shared, so the header and link-hygiene
 * contracts are asserted for every mirror, not just /llms.txt: a client
 * that fetched the text by URL cannot resolve relative links, and the
 * canonical domain must not drift onto staging hosts. Copy edits stay
 * free to change; structural drift fails. */
const MIRRORS = [
  {
    path: "/llms.txt",
    loader: llmsTxtLoader,
    content: llmsTxt,
    type: "text/plain",
  },
  {
    path: "/about.md",
    loader: aboutLoader,
    content: aboutMarkdown,
    type: "text/markdown",
  },
  {
    path: "/faq.md",
    loader: faqLoader,
    content: faqMarkdown,
    type: "text/markdown",
  },
  {
    path: "/alternatives.md",
    loader: alternativesLoader,
    content: alternativesMarkdown,
    type: "text/markdown",
  },
  {
    path: "/connect.md",
    loader: connectLoader,
    content: connectMarkdown,
    type: "text/markdown",
  },
] as const;

/** All markdown link hrefs in a document. */
function markdownLinks(text: string): string[] {
  return [...text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

describe.each(MIRRORS)("GET $path", ({ loader, content, type }) => {
  it("serves the right content type with the shared public cache header", async () => {
    const res = await loader();
    expect(res.headers.get("Content-Type")).toBe(`${type}; charset=utf-8`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("serves its seo-content body verbatim", async () => {
    const res = await loader();
    await expect(res.text()).resolves.toBe(content());
  });

  it("only links absolute https URLs with non-empty titles", () => {
    // The mirrors may legitimately contain zero markdown links (about.md
    // cites bare URLs in prose); the per-link rules apply to whatever
    // exists.
    for (const [, title, href] of content().matchAll(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
    )) {
      expect(title.trim()).not.toBe("");
      expect(href).toMatch(/^https:\/\//);
      expect(href).not.toMatch(/\s/);
    }
  });

  it("keeps every link on the canonical domains", () => {
    for (const href of markdownLinks(content())) {
      expect(
        href.startsWith(`${SITE_URL}/`) ||
          href.startsWith("https://labnotes.org"),
        `${href} is off the canonical domains`,
      ).toBe(true);
    }
  });

  it("contains no placeholder or unfinished markers", () => {
    expect(content()).not.toMatch(/\bTODO\b|\bFIXME\b|lorem ipsum/i);
  });
});

describe("/llms.txt specific contract", () => {
  it("is a curated link hub with a useful set of core pages", () => {
    // The llmstxt.org point of the file: pointers the reader can follow.
    expect(markdownLinks(llmsTxt()).length).toBeGreaterThanOrEqual(5);
  });

  it("starts with an H1 title followed by a blockquote summary", () => {
    const lines = llmsTxt().split("\n");
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
});
