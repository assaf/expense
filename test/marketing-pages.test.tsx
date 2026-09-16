import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { DocumentPage } from "~/data/content-types";
import {
  ABOUT,
  AI,
  ALTERNATIVES,
  CONNECT,
  FAQ,
  MCP,
  MILEAGE_PAGE,
  PRIVACY,
  SCHEDULE_C_PAGE,
  SITE,
  SUPPORT,
  TERMS,
  scheduleCRows,
} from "~/lib/content.server";
import { mileageRateRows, SITE_URL } from "~/lib/seo-content";
import * as about from "~/routes/about";
import * as ai from "~/routes/ai";
import * as alternatives from "~/routes/alternatives";
import * as connect from "~/routes/connect";
import * as faq from "~/routes/faq";
import * as mileageRates from "~/routes/mileage-rates";
import * as privacy from "~/routes/privacy";
import * as scheduleC from "~/routes/schedule-c-categories";
import * as support from "~/routes/support";
import * as terms from "~/routes/terms";

// The ten public pages are the AI-search and app-review surface, and nothing
// used to render one: the content tests prove the files parse, the mirror
// tests prove the .md bodies carry them, and the screenshot suite skips its
// comparisons in CI (test/helpers/toMatchScreenshot.ts) and covers two pages.
// These two contracts close that: a page points its canonical URL at its own
// path, and it shows the strings its content file supplies. Copying a route
// and forgetting its path, or dropping a section from a page's JSX, fails here.

/** Route prop types differ per page (each loader returns its own shape, and
 * ComponentProps wants the whole route context); rendering needs loaderData. */
function renderPage(mod: { default: unknown }, loaderData: unknown): string {
  const Page = mod.default as (props: { loaderData: unknown }) => ReactElement;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <Page loaderData={loaderData} />
    </MemoryRouter>,
  );
}

/** The tags the route's meta() contributes for its loader data. */
function metaTags(mod: { meta: unknown }, loaderData: unknown): unknown[] {
  const meta = mod.meta as (args: { loaderData: unknown }) => unknown[];
  return meta({ loaderData });
}

/** What the reader sees: scripts and tags gone, React's entities put back. */
function text(html: string): string {
  return html
    .replaceAll(/<script[\s\S]*?<\/script>/g, " ")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/** Content strings carry the inline markup their page renders; compare the
 * text both sides end up with. */
function plain(value: string): string {
  return value
    .replaceAll(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replaceAll("**", "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/** The hero every page renders, and the CTA panel when it has one. */
function hero(page: {
  eyebrow: string;
  title: string;
  summary: string;
  cta?: { heading: string; body: string; secondaryLabel?: string };
}): string[] {
  const labels = page.cta?.secondaryLabel ? [page.cta.secondaryLabel] : [];
  return [page.eyebrow, page.title, page.summary, ...labels];
}

/** A document's copy: its date, then each section heading and paragraph. */
function sections(page: Readonly<DocumentPage>): string[] {
  return [
    page.updated,
    ...page.sections.flatMap((section) => [
      section.title,
      ...section.paragraphs.map((paragraph) =>
        paragraph.map((segment) => segment.text).join(""),
      ),
    ]),
  ];
}

/** The MCP copy /ai and /connect both render (app/data/mcp.yaml). The prompts
 * heading is the one exception: each page names its own. */
const MCP_SECTIONS = [
  MCP.capabilitiesHeading,
  ...MCP.capabilities.flatMap((capability) => [
    capability.title,
    capability.body,
  ]),
];
const MCP_SECURITY = [MCP.securityHeading, MCP.security];

/** /connect opens on its first client; the rest are behind the switcher. */
const OPEN_CLIENT = CONNECT.clients[0]!;

interface MarketingPage {
  path: string;
  mod: { default: unknown; meta: unknown };
  /** The loader's return value, shape for shape. */
  data: unknown;
  /** Strings the page must show, drawn from that same content. */
  shows: string[];
}

const PAGES: MarketingPage[] = [
  {
    path: "/terms",
    mod: terms,
    data: TERMS,
    shows: [...hero(TERMS), ...sections(TERMS)],
  },
  {
    path: "/privacy",
    mod: privacy,
    data: PRIVACY,
    shows: [...hero(PRIVACY), ...sections(PRIVACY)],
  },
  {
    path: "/support",
    mod: support,
    data: SUPPORT,
    shows: [...hero(SUPPORT), ...sections(SUPPORT)],
  },
  {
    path: "/faq",
    mod: faq,
    data: FAQ,
    shows: [
      ...hero(FAQ),
      ...FAQ.questions.flatMap((question) => [
        question.question,
        question.answer,
      ]),
    ],
  },
  {
    path: "/about",
    mod: about,
    data: { ...ABOUT, keyFacts: SITE.keyFacts },
    shows: [
      ...hero(ABOUT),
      ABOUT.benefitsHeading,
      ABOUT.factsHeading,
      ...ABOUT.benefits.flatMap((benefit) => [benefit.title, benefit.body]),
      ...SITE.keyFacts,
    ],
  },
  {
    path: "/alternatives",
    mod: alternatives,
    data: ALTERNATIVES,
    shows: [
      ...hero(ALTERNATIVES),
      ...ALTERNATIVES.tableHeadings,
      ...ALTERNATIVES.competitors.flatMap((row) => [
        row.app,
        row.bestFor,
        row.pricing,
        row.taxFiling,
      ]),
      ALTERNATIVES.pricingNote,
    ],
  },
  {
    path: "/ai",
    mod: ai,
    data: { ...AI, mcp: MCP },
    shows: [
      ...hero(AI),
      ...MCP_SECTIONS,
      MCP.promptsHeading,
      ...MCP.prompts,
      ...MCP_SECURITY,
      AI.stepsHeading,
      ...AI.steps.flatMap((step) => [step.title, step.body]),
      AI.insightsHeading,
      AI.insightsSummary,
      AI.connectNote,
      AI.webmcpHeading,
      AI.webmcpBody,
      AI.mcpConfigHeading,
      AI.mcpConfigJson,
    ],
  },
  {
    path: "/connect",
    mod: connect,
    data: { ...CONNECT, mcp: MCP },
    shows: [
      ...hero(CONNECT),
      ...MCP_SECTIONS,
      CONNECT.promptsHeading,
      ...MCP.prompts,
      ...MCP_SECURITY,
      CONNECT.setupHeading,
      CONNECT.baseAddressLabel,
      CONNECT.oauthNote,
      // One client's instructions show at a time: every client names its tab,
      // and the page opens on the first. The rest (their steps, code and
      // notes) are carried by /connect.md, which test/llms-txt.test.ts checks
      // client by client.
      ...CONNECT.clients.map((client) => client.short ?? client.name),
      ...OPEN_CLIENT.steps,
      ...(OPEN_CLIENT.note ? [OPEN_CLIENT.note] : []),
      CONNECT.toolsHeading,
      ...CONNECT.tools.flatMap((tool) => [tool.name, tool.what]),
      CONNECT.securityNote,
    ],
  },
  {
    path: "/mileage-rates",
    mod: mileageRates,
    data: { ...MILEAGE_PAGE, rows: mileageRateRows() },
    shows: [
      ...hero(MILEAGE_PAGE),
      ...MILEAGE_PAGE.tableHeadings,
      MILEAGE_PAGE.sourceNote,
      ...mileageRateRows().flatMap((row) => [
        row.period,
        `$${row.business}`,
        `$${row.medical}`,
        `$${row.moving}`,
        `$${row.charity}`,
      ]),
    ],
  },
  {
    path: "/schedule-c-categories",
    mod: scheduleC,
    data: { ...SCHEDULE_C_PAGE, rows: scheduleCRows() },
    shows: [
      ...hero(SCHEDULE_C_PAGE),
      ...SCHEDULE_C_PAGE.tableHeadings,
      ...scheduleCRows().flatMap((row) => [row.line, row.name, row.note]),
      SCHEDULE_C_PAGE.sourceNote,
    ],
  },
];

describe("public marketing pages", () => {
  it.each(PAGES)(
    "$path shows the copy in its content file",
    ({ data, mod, path, shows }) => {
      const body = text(renderPage(mod, data));
      for (const expected of shows) {
        expect(body, `${path}: ${expected.slice(0, 70)}`).toContain(
          plain(expected),
        );
      }
    },
  );

  it.each(PAGES)(
    "$path points its canonical URL at itself",
    ({ data, mod, path }) => {
      const tags = metaTags(mod, data);
      for (const tag of [
        { tagName: "link", rel: "canonical", href: `${SITE_URL}${path}` },
        { property: "og:url", content: `${SITE_URL}${path}` },
      ]) {
        expect(tags, path).toContainEqual(tag);
      }
    },
  );

  it.each(PAGES)(
    "$path navigates its own links in the client",
    ({ data, mod, path, shows }) => {
      const html = renderPage(mod, data);
      const links = shows.flatMap((value) =>
        [...value.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map(
          (match) => match[1]!,
        ),
      );
      for (const href of links) {
        // A site link becomes a relative href (a click stays in the app); an
        // outbound one keeps its absolute URL.
        expect(html, `${path}: ${href}`).toContain(
          href.startsWith(`${SITE_URL}/`)
            ? `href="${href.slice(SITE_URL.length)}"`
            : `href="${href}"`,
        );
      }
    },
  );
});

describe("the support page", () => {
  // Its reason to exist is telling a stuck user who to write to, and Fastmail's
  // app registration points at this page, so the address is the one string a
  // copy edit must not quietly take away.
  it("leaves the reader an address to write to", () => {
    expect(text(renderPage(support, SUPPORT))).toMatch(
      /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    );
  });
});
