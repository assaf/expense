import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { loader as aboutLoader } from "~/routes/about[.]md";
import { loader as changelogLoader } from "~/routes/changelog[.]md";
import { loader as productFactsLoader } from "~/routes/product-facts[.]md";
import { loader as scheduleCLoader } from "~/routes/schedule-c-categories[.]md";
import { loader as mileageRatesLoader } from "~/routes/mileage-rates[.]md";
import { loader as alternativesLoader } from "~/routes/alternatives[.]md";
import { loader as connectLoader } from "~/routes/connect[.]md";
import { loader as aiLoader } from "~/routes/ai[.]md";
import { loader as faqLoader } from "~/routes/faq[.]md";
import { loader as privacyLoader } from "~/routes/privacy[.]md";
import { loader as supportLoader } from "~/routes/support[.]md";
import { loader as termsLoader } from "~/routes/terms[.]md";
import { loader as llmsTxtLoader } from "~/routes/llms[.]txt";
import {
  ABOUT,
  AI,
  ALTERNATIVES,
  CHANGELOG,
  CONNECT,
  FAQ,
  LLMS,
  MCP,
  MILEAGE_PAGE,
  PRIVACY,
  PRODUCT_FACTS,
  SCHEDULE_C_PAGE,
  SITE,
  SUPPORT,
  TERMS,
  aboutMarkdown,
  aiMarkdown,
  alternativesMarkdown,
  changelogMarkdown,
  changelogReleases,
  connectMarkdown,
  faqMarkdown,
  fillPlaceholders,
  privacyMarkdown,
  productFactsMarkdown,
  termsMarkdown,
  scheduleCCategoriesMarkdown,
  scheduleCRows,
  llmsTxt,
  mileageRatesMarkdown,
  supportMarkdown,
} from "~/lib/content.server";
import { mileageRateRows, SITE_URL } from "~/lib/seo-content";

/** The public text mirrors (llmstxt.org convention) and their routes. The
 * loader wiring is shared, so the header and link-hygiene contracts are
 * asserted for every mirror, not just /llms.txt: a client that fetched the
 * text by URL cannot resolve relative links, and the canonical domain must
 * not drift onto staging hosts. Copy edits stay free to change; structural
 * drift fails. */
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
    path: "/ai.md",
    loader: aiLoader,
    content: aiMarkdown,
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
  {
    path: "/product-facts.md",
    loader: productFactsLoader,
    content: productFactsMarkdown,
    type: "text/markdown",
  },
  {
    path: "/changelog.md",
    loader: changelogLoader,
    content: changelogMarkdown,
    type: "text/markdown",
  },
  {
    path: "/schedule-c-categories.md",
    loader: scheduleCLoader,
    content: scheduleCCategoriesMarkdown,
    type: "text/markdown",
  },
  {
    path: "/mileage-rates.md",
    loader: mileageRatesLoader,
    content: mileageRatesMarkdown,
    type: "text/markdown",
  },
  {
    path: "/privacy.md",
    loader: privacyLoader,
    content: privacyMarkdown,
    type: "text/markdown",
  },
  {
    path: "/terms.md",
    loader: termsLoader,
    content: termsMarkdown,
    type: "text/markdown",
  },
  {
    path: "/support.md",
    loader: supportLoader,
    content: supportMarkdown,
    type: "text/markdown",
  },
] as const;

/** All markdown link hrefs in a document. */
function markdownLinks(text: string): string[] {
  return [...text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

/** The text a reader sees: markdown link syntax and bold markers removed. */
function plain(markdown: string): string {
  return markdown
    .replaceAll(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replaceAll("**", "");
}

/** Collapse whitespace, the way a mirror's own wrapping does. */
function collapse(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

/** A document's sections, past its front matter and the mirror's own
 * title/summary preamble. Placeholders are filled first, so a source file and
 * the mirror built from it carry the same values. */
function documentSections(text: string): string {
  const body = fillPlaceholders(text.replace(/^---\n[\s\S]*?\n---\n/, ""));
  const at = body.indexOf("## ");
  return at === -1 ? "" : body.slice(at);
}

describe.each(MIRRORS)("GET $path", ({ loader, content, type }) => {
  it("serves the right content type with the shared public cache header", async () => {
    const res = await loader();
    expect(res.headers.get("Content-Type")).toBe(`${type}; charset=utf-8`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("serves its content.server body verbatim", async () => {
    const res = await loader();
    await expect(res.text()).resolves.toBe(content());
  });

  it("only links absolute URLs with non-empty titles", () => {
    // The mirrors may legitimately contain zero markdown links (about.md
    // cites bare URLs in prose); the per-link rules apply to whatever
    // exists. Absolute is the point: a reader that fetched the text by URL
    // cannot resolve a relative one. A mailto is absolute too, and is how a
    // support address stays clickable in a text mirror.
    for (const [, title, href] of content().matchAll(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
    )) {
      expect(title.trim()).not.toBe("");
      expect(href).toMatch(/^(https:\/\/|mailto:)/);
      expect(href).not.toMatch(/\s/);
    }
  });

  it("keeps every link on the canonical domains", () => {
    for (const href of markdownLinks(content())) {
      // irs.gov is the primary source on the mileage-rate page; every other
      // link stays on the canonical domains, and a mailto is an address
      // rather than a host.
      expect(
        href.startsWith(`${SITE_URL}/`) ||
          href.startsWith("https://labnotes.org") ||
          href.startsWith("https://www.irs.gov/") ||
          href.startsWith("mailto:"),
        `${href} is off the canonical domains`,
      ).toBe(true);
    }
  });

  it("contains no placeholder or unfinished markers", () => {
    expect(content()).not.toMatch(/\{\{|\bTODO\b|\bFIXME\b|lorem ipsum/i);
  });
});

/** The point of one source for two surfaces: an edit to the content files
 * reaches the mirror. Each case checks the strings a reader would miss if
 * the assembly dropped them. */
describe("mirrors lose no content", () => {
  it("carries every document section and paragraph", () => {
    for (const [text, page] of [
      [termsMarkdown(), TERMS],
      [privacyMarkdown(), PRIVACY],
      [supportMarkdown(), SUPPORT],
    ] as const) {
      const body = plain(text);
      expect(text).toContain(`# ${page.mirror.title}`);
      expect(text).toContain(page.summary);
      expect(text).toContain(`Last updated: ${page.updated}`);
      for (const section of page.sections) {
        expect(text).toContain(`## ${section.title}`);
        for (const block of section.blocks) {
          // A bullet item is prose too: the mirror drops it just as easily.
          const paragraphs =
            block.kind === "paragraph" ? [block.segments] : block.items;
          for (const paragraph of paragraphs) {
            expect(body).toContain(paragraph.map((seg) => seg.text).join(""));
          }
        }
      }
    }
  });

  it("carries every benefit, key fact and the about summary", () => {
    const body = plain(aboutMarkdown());
    expect(body).toContain(SITE.appSummary);
    expect(body).toContain(SITE.appTagline);
    for (const benefit of ABOUT.benefits) {
      expect(body).toContain(collapse(benefit.title));
      expect(body).toContain(collapse(benefit.body));
    }
    for (const fact of SITE.keyFacts) {
      expect(body).toContain(collapse(fact));
    }
  });

  it("carries every FAQ question and answer", () => {
    const text = faqMarkdown();
    const body = plain(text);
    for (const faq of FAQ.questions) {
      expect(text).toContain(`## ${faq.question}`);
      expect(body).toContain(collapse(faq.answer));
    }
  });

  it("carries every competitor row and the pricing note", () => {
    const body = plain(alternativesMarkdown());
    // The summary keeps its own line breaks in the mirror: it is emitted
    // verbatim, not re-wrapped.
    expect(body).toContain(ALTERNATIVES.summary);
    for (const row of ALTERNATIVES.competitors) {
      expect(body).toContain(collapse(row.app));
      expect(body).toContain(collapse(row.bestFor));
      expect(body).toContain(collapse(row.pricing));
      expect(body).toContain(collapse(row.taxFiling));
    }
    expect(body).toContain(collapse(plain(ALTERNATIVES.pricingNote)));
    expect(body).toContain(collapse(ALTERNATIVES.inboxNote));
    expect(body).toContain(collapse(ALTERNATIVES.exampleIntro));
    expect(body).toContain(collapse(plain(ALTERNATIVES.mappingNote)));
    expect(body).toContain(collapse(plain(ALTERNATIVES.sourcesNote)));
    for (const app of ALTERNATIVES.inboxApps) {
      expect(body).toContain(collapse(app.app));
      expect(body).toContain(collapse(app.inbox));
      expect(body).toContain(collapse(app.scheduleC));
      expect(body).toContain(collapse(app.mileage));
    }
    for (const step of ALTERNATIVES.example) {
      expect(body).toContain(collapse(step.step));
      expect(body).toContain(collapse(step.what));
    }
    for (const row of ALTERNATIVES.mapping) {
      expect(body).toContain(collapse(row.email));
      expect(body).toContain(collapse(row.lands));
    }
    for (const limit of ALTERNATIVES.limits) {
      expect(body).toContain(collapse(limit));
    }
    // Provenance travels with the claims: a cell about a rival's product has
    // to name the page it came from and the date it was read.
    const text2 = alternativesMarkdown();
    for (const source of ALTERNATIVES.sources) {
      expect(body).toContain(collapse(source.app));
      expect(body).toContain(collapse(source.checked));
      for (const url of source.urls) {
        expect(text2).toContain(url);
      }
    }
  });

  it("carries every capability, step, prompt and the security note", () => {
    const body = plain(aiMarkdown());
    expect(body).toContain(collapse(AI.summary));
    expect(body).toContain(collapse(AI.insightsSummary));
    expect(body).toContain(collapse(MCP.security));
    for (const capability of MCP.capabilities) {
      expect(body).toContain(collapse(capability.title));
      expect(body).toContain(collapse(capability.body));
    }
    for (const step of AI.steps) {
      expect(body).toContain(collapse(step.title));
      expect(body).toContain(collapse(step.body));
    }
    for (const prompt of MCP.prompts) {
      expect(body).toContain(collapse(prompt));
    }
  });

  it("carries every MCP client, its steps and code, and every tool", () => {
    const body = plain(connectMarkdown());
    expect(body).toContain(collapse(CONNECT.summary));
    expect(body).toContain(collapse(MCP.security));
    for (const client of CONNECT.clients) {
      expect(body).toContain(`### ${client.name}`);
      for (const step of client.steps) {
        expect(body).toContain(collapse(step));
      }
      if (client.code) {
        expect(body).toContain(`\`\`\`${client.code.lang}`);
        expect(body).toContain(client.code.body);
      }
      if (client.note) expect(body).toContain(collapse(client.note));
    }
    for (const tool of CONNECT.tools) {
      expect(body).toContain(`\`${tool.name}\``);
      expect(body).toContain(collapse(tool.what));
    }
  });

  it("carries every rate period with its four rates", () => {
    const text = mileageRatesMarkdown();
    expect(text).toContain(plain(MILEAGE_PAGE.mirror.explanation));
    for (const row of mileageRateRows()) {
      expect(text).toContain(
        `| ${row.period} | $${row.business} | $${row.medical} | $${row.moving} | $${row.charity} |`,
      );
    }
  });

  it("carries every fact, capture method, price line and Schedule C line", () => {
    const text = productFactsMarkdown();
    const body = plain(text);
    expect(body).toContain(collapse(PRODUCT_FACTS.summary));
    expect(body).toContain(collapse(plain(PRODUCT_FACTS.categoriesNote)));
    expect(body).toContain(collapse(PRODUCT_FACTS.mirror.footer));
    for (const fact of PRODUCT_FACTS.facts) {
      expect(body).toContain(collapse(fact.label));
      expect(body).toContain(collapse(plain(fact.value)));
    }
    for (const method of PRODUCT_FACTS.capture) {
      expect(body).toContain(collapse(method.method));
      expect(body).toContain(collapse(method.what));
    }
    for (const line of PRODUCT_FACTS.pricing) {
      expect(body).toContain(collapse(line));
    }
    for (const row of scheduleCRows()) {
      expect(text).toContain(`- Line ${row.line} ${row.name}`);
    }
  });

  it("carries every dated release with its typed changes", () => {
    const text = changelogMarkdown();
    // The mirror is the surface a model reads to date a capability, so a
    // group that lost its heading, or an entry that lost its type, is the
    // drift worth failing on.
    for (const release of changelogReleases()) {
      expect(text).toContain(`## ${release.date}`);
      for (const change of release.changes) {
        expect(text).toContain(
          `- **${CHANGELOG.typeLabels[change.type]}:** ${collapse(change.text)}`,
        );
      }
    }
  });

  it("carries every Schedule C line with its seeded category and note", () => {
    const text = scheduleCCategoriesMarkdown();
    expect(text).toContain(`| ${SCHEDULE_C_PAGE.tableHeadings.join(" | ")} |`);
    for (const row of scheduleCRows()) {
      expect(text).toContain(`| ${row.line} | ${row.name} | ${row.note} |`);
    }
  });

  it("carries every llms.txt page with its URL and blurb", () => {
    const text = llmsTxt();
    for (const page of LLMS.corePages) {
      expect(text).toContain(`- [${page.title}](${page.url}): ${page.blurb}`);
    }
    for (const page of LLMS.optionalPages) {
      expect(text).toContain(`- [${page.title}](${page.url})`);
    }
    for (const fact of SITE.keyFacts) {
      expect(text).toContain(collapse(fact));
    }
  });
});

describe("document mirrors are their source files", () => {
  // The documents are hand-edited prose (bullet lists included), and the
  // mirror is assembled from the parse of them. Compared with the placeholders
  // filled from the same values, the structure has to come back line for line:
  // a bullet list the mirror flattens into paragraphs, or a section that loses
  // its blank line, fails here instead of reaching a reader.
  it.each([
    ["terms", termsMarkdown()],
    ["privacy", privacyMarkdown()],
    ["support", supportMarkdown()],
  ] as const)("%s.md reproduces app/data/%s.md", (name, mirror) => {
    expect(documentSections(mirror)).toBe(
      documentSections(
        readFileSync(
          new URL(`../app/data/${name}.md`, import.meta.url),
          "utf8",
        ),
      ),
    );
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

describe("sitemap coverage", () => {
  // public/sitemap.xml is static and hand-edited; this keeps it honest
  // against the one list that must stay complete: llms.txt's core pages.
  const sitemap = readFileSync(
    new URL("../public/sitemap.xml", import.meta.url),
    "utf8",
  );
  const locs = new Set(
    [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
  );

  it("lists every app page llms.txt advertises", () => {
    const paths = new Set(
      markdownLinks(llmsTxt())
        .filter((href) => href.startsWith(`${SITE_URL}/`))
        .map((href) => new URL(href).pathname.replace(/\.md$/, "")),
    );
    for (const path of paths) {
      expect(
        locs.has(`${SITE_URL}${path}`),
        `${path} is in llms.txt but missing from public/sitemap.xml`,
      ).toBe(true);
    }
  });
});
