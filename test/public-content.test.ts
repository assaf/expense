import { readdirSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  ABOUT,
  AI,
  ALTERNATIVES,
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
  authMarkdown,
  connectMarkdown,
  faqMarkdown,
  llmsTxt,
  mileageRatesMarkdown,
  privacyMarkdown,
  productFactsMarkdown,
  scheduleCCategoriesMarkdown,
  supportMarkdown,
  termsMarkdown,
} from "~/lib/content.server";
import { DEFAULT_CATEGORIES } from "~/lib/default-categories.server";
import {
  currentMileageSummary,
  EARLY_ACCESS_SPOTS,
  MCP_ENDPOINT,
  mileageRateRows,
  SITE_URL,
} from "~/lib/seo-content";

/** The copy under app/data/ is edited by hand, so these are the assertions
 * that catch an editing mistake: a file nothing imports, a page that lost
 * its meta, a placeholder nobody filled, a FAQ entry with no answer.
 * test/llms-txt.test.ts covers the mirror bodies; this covers the files. */

/** Every content file, by name. */
const CONTENT_FILES = [
  "about.yaml",
  "ai.yaml",
  "alternatives.yaml",
  "auth.md",
  "connect.yaml",
  "content-types.ts",
  "default-categories.csv",
  "email-rules.csv",
  "email-rules.ts",
  "faq.yaml",
  "llms.yaml",
  "mcp.yaml",
  "mileage-rates.ts",
  "mileage-rates.yaml",
  "notification-senders.ts",
  "parse-categories.ts",
  "parse-warranty-policies.ts",
  "privacy.md",
  "product-facts.yaml",
  "schedule-c-categories.yaml",
  "site.yaml",
  "support.md",
  "terms.md",
  "warranty-policies.ts",
  "warranty-policies.yaml",
];

const PAGES = [
  ["terms", TERMS],
  ["privacy", PRIVACY],
  ["support", SUPPORT],
  ["faq", FAQ],
  ["about", ABOUT],
  ["alternatives", ALTERNATIVES],
  ["ai", AI],
  ["connect", CONNECT],
  ["mileage-rates", MILEAGE_PAGE],
  ["schedule-c-categories", SCHEDULE_C_PAGE],
  ["product-facts", PRODUCT_FACTS],
] as const;

describe("public content directory", () => {
  it("holds exactly the files the parser and the app know about", () => {
    // A stray content file nothing imports is a silent copy edit that never
    // ships; a deleted tracked file breaks the build, so this only has to
    // catch the first case.
    expect(readdirSync("app/data").toSorted()).toEqual(
      CONTENT_FILES.toSorted(),
    );
  });
});

describe("public page content", () => {
  it.each(PAGES)("%s carries its page metadata", (_name, page) => {
    for (const field of [
      "metaTitle",
      "description",
      "eyebrow",
      "title",
      "summary",
    ] as const) {
      expect(page[field].trim(), field).not.toBe("");
    }
    expect(page.title).not.toContain("\n");
    expect(page.eyebrow.length).toBeLessThan(30);
  });

  it("gives every page a filled call to action", () => {
    for (const page of [
      FAQ,
      ABOUT,
      ALTERNATIVES,
      AI,
      CONNECT,
      MILEAGE_PAGE,
      SCHEDULE_C_PAGE,
      PRODUCT_FACTS,
    ]) {
      expect(page.cta.heading.trim()).not.toBe("");
      expect(page.cta.body.trim()).not.toBe("");
    }
  });

  it("leaves no placeholder anywhere in the built content", () => {
    const bundles = [
      SITE,
      MCP,
      TERMS,
      PRIVACY,
      SUPPORT,
      FAQ,
      ABOUT,
      ALTERNATIVES,
      AI,
      CONNECT,
      MILEAGE_PAGE,
      SCHEDULE_C_PAGE,
      PRODUCT_FACTS,
      LLMS,
    ];
    const mirrors = [
      termsMarkdown(),
      privacyMarkdown(),
      supportMarkdown(),
      faqMarkdown(),
      aboutMarkdown(),
      alternativesMarkdown(),
      aiMarkdown(),
      connectMarkdown(),
      mileageRatesMarkdown(),
      scheduleCCategoriesMarkdown(),
      productFactsMarkdown(),
      llmsTxt(),
      authMarkdown(),
    ];
    for (const text of [
      ...bundles.map((bundle) => JSON.stringify(bundle)),
      ...mirrors,
    ]) {
      // A malformed token (`{{ siteUrl }}`) would survive `fill`; the opening
      // braces are what it cannot hide behind.
      expect(text).not.toContain("{{");
    }
  });

  it("computes the values the placeholders stand for", () => {
    // The rate sentence, the current period, and the seeded category count
    // are read from data, not typed into a content file.
    const rows = mileageRateRows();
    expect(FAQ.questions.some((q) => q.answer.includes("per mile"))).toBe(true);
    expect(MILEAGE_PAGE.metaTitle).toContain(
      `${rows.at(-1)!.start.slice(0, 4)} to ${rows[0]!.end.slice(0, 4)}`,
    );
    expect(MILEAGE_PAGE.description).toContain(currentMileageSummary());
    expect(SCHEDULE_C_PAGE.description).toContain(
      `The ${DEFAULT_CATEGORIES.length} expense lines`,
    );
    // The fact sheet quotes the same two computed numbers the landing page
    // and the Schedule C page do: the early-access cap and the seeded
    // category count, never a number typed into the file.
    expect(PRODUCT_FACTS.description).toContain(String(EARLY_ACCESS_SPOTS));
    expect(
      PRODUCT_FACTS.facts.some((fact) =>
        fact.value.includes(String(EARLY_ACCESS_SPOTS)),
      ),
    ).toBe(true);
    expect(
      PRODUCT_FACTS.facts.some((fact) =>
        fact.value.includes(String(DEFAULT_CATEGORIES.length)),
      ),
    ).toBe(true);
    expect(CONNECT.clients.every((client) => client.steps.length > 0)).toBe(
      true,
    );
  });

  it("answers every FAQ question with text", () => {
    expect(FAQ.questions.length).toBeGreaterThan(10);
    for (const faq of FAQ.questions) {
      expect(faq.question, faq.question).toMatch(/\?$/);
      expect(faq.answer.trim().length, faq.question).toBeGreaterThan(40);
    }
  });

  it("links the llms.txt core pages on the canonical domain only", () => {
    expect(LLMS.corePages.length).toBeGreaterThanOrEqual(5);
    for (const page of LLMS.corePages) {
      expect(page.url.startsWith(`${SITE_URL}/`), page.url).toBe(true);
      expect(page.blurb.trim(), page.title).not.toBe("");
    }
    for (const page of LLMS.optionalPages) {
      expect(page.url).toMatch(/^https:\/\//);
    }
  });

  it("names the MCP endpoint the app actually serves", () => {
    expect(AI.mcpConfigJson).toContain(MCP_ENDPOINT);
    expect(
      CONNECT.clients.some((client) =>
        client.steps.join(" ").includes(MCP_ENDPOINT),
      ),
    ).toBe(true);
  });
});
