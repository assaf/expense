import { parse as parseYaml } from "yaml";
import aboutYaml from "~/data/about.yaml?raw";
import aiYaml from "~/data/ai.yaml?raw";
import alternativesYaml from "~/data/alternatives.yaml?raw";
import type {
  AboutPage,
  AiPage,
  AlternativesPage,
  ConnectPage,
  DocumentPage,
  FaqPage,
  LlmsContent,
  McpContent,
  MileageRatesPage,
  MirrorMeta,
  PageMeta,
  ScheduleCPage,
  SiteContent,
} from "~/data/content-types";
import connectYaml from "~/data/connect.yaml?raw";
import faqYaml from "~/data/faq.yaml?raw";
import llmsYaml from "~/data/llms.yaml?raw";
import mcpYaml from "~/data/mcp.yaml?raw";
import mileageRatesYaml from "~/data/mileage-rates.yaml?raw";
import privacyMd from "~/data/privacy.md?raw";
import scheduleCYaml from "~/data/schedule-c-categories.yaml?raw";
import siteYaml from "~/data/site.yaml?raw";
import supportMd from "~/data/support.md?raw";
import termsMd from "~/data/terms.md?raw";
import { DEFAULT_CATEGORIES } from "~/lib/default-categories.server";
import {
  parseMarkdown,
  splitSections,
  type InlineSegment,
} from "~/lib/markdown";
import {
  currentMileageSummary,
  MCP_ENDPOINT,
  mileageRateRows,
  SITE_URL,
} from "~/lib/seo-content";

/**
 * The site's public copy: parsed from the markdown documents and YAML bundles
 * under `app/data/`, and exported as one frozen bundle per page. This is the
 * only module that reads the raw files, and everything else consumes what it
 * builds: the ten marketing routes render these objects, and the eleven
 * `.md` / `.txt` mirrors assemble their bodies from the same fields, so a
 * page and its mirror cannot drift apart.
 *
 * Two kinds of file:
 *
 * - A **document** (`terms.md`, `privacy.md`, `support.md`) is markdown with
 *   front matter.
 *   YAML front matter carries the page's meta, and the body is the copy:
 *   `## ` opens a section, and each paragraph is one line.
 * - A **bundle** (`about.yaml`, `faq.yaml`, …) is name/value YAML, one file
 *   per page, plus the shared `site.yaml` (brand copy) and `mcp.yaml` (the
 *   MCP copy /ai and /connect share).
 *
 * Placeholders — `{{siteUrl}}`, `{{mcpEndpoint}}`, `{{mileage}}`,
 * `{{mileagePeriod}}`, `{{mileageFirstYear}}`, `{{mileageLastYear}}`,
 * `{{categoryCount}}` — are filled in here from the values the app already
 * computes, so a domain or an IRS rate never has to be typed twice. An
 * unknown or malformed placeholder throws at build time rather than
 * shipping braces to a reader.
 *
 * Anything wrong with a file (a missing key, an empty value, a table in a
 * document) throws with the file name: a content edit that breaks a page
 * should fail loudly, not render a blank section.
 */

const FILE = {
  site: "app/data/site.yaml",
  mcp: "app/data/mcp.yaml",
  terms: "app/data/terms.md",
  privacy: "app/data/privacy.md",
  support: "app/data/support.md",
  faq: "app/data/faq.yaml",
  about: "app/data/about.yaml",
  alternatives: "app/data/alternatives.yaml",
  ai: "app/data/ai.yaml",
  connect: "app/data/connect.yaml",
  mileage: "app/data/mileage-rates.yaml",
  scheduleC: "app/data/schedule-c-categories.yaml",
  llms: "app/data/llms.yaml",
} as const;

// --- Placeholders -----------------------------------------------------------

/** Whatever an edit can leave in a file that the app computes: the canonical
 * URLs the app already knows, and the IRS figures it derives from data. */
const CONTENT_VALUES: Record<string, string> = {
  siteUrl: SITE_URL,
  mcpEndpoint: MCP_ENDPOINT,
  mileage: currentMileageSummary(),
  mileagePeriod: mileageRateRows()[0]!.period,
  mileageFirstYear: mileageRateRows().at(-1)!.start.slice(0, 4),
  mileageLastYear: mileageRateRows()[0]!.end.slice(0, 4),
  categoryCount: String(DEFAULT_CATEGORIES.length),
};

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Fill the placeholders in one string, rejecting anything left behind. */
function fill(file: string, text: string): string {
  const filled = text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = CONTENT_VALUES[name];
    if (value === undefined) {
      throw new Error(`${file}: unknown placeholder {{${name}}}`);
    }
    return value;
  });
  if (filled.includes("{{")) {
    throw new Error(
      `${file}: unresolved placeholder in "${filled.slice(0, 60)}…"`,
    );
  }
  return filled;
}

/** Fill every string in a parsed bundle. */
function fillValue<T>(file: string, value: T): T {
  if (typeof value === "string") return fill(file, value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => fillValue(file, item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        fillValue(file, item),
      ]),
    ) as unknown as T;
  }
  return value;
}

// --- Reading the files ------------------------------------------------------

/** Reject a file that is missing a key, or whose value is empty. */
function requireKeys(
  file: string,
  data: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const name of keys) {
    const value = data[name];
    if (value === undefined) throw new Error(`${file}: missing "${name}"`);
    if (typeof value === "string" && value.trim() === "") {
      throw new Error(`${file}: "${name}" is empty`);
    }
    if (Array.isArray(value) && value.length === 0) {
      throw new Error(`${file}: "${name}" is empty`);
    }
  }
}

/** Reject empty or non-scalar values anywhere in a parsed bundle. */
function assertContent(file: string, value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value.trim() === "") throw new Error(`${file}: empty value at ${path}`);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error(`${file}: empty list at ${path}`);
    for (const [index, item] of value.entries()) {
      assertContent(file, item, `${path}[${index}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) {
      assertContent(file, item, `${path}.${name}`);
    }
    return;
  }
  throw new Error(`${file}: unexpected ${typeof value} at ${path}`);
}

/** Parse a YAML bundle, check it, and fill its placeholders. */
function bundle<T>(
  file: string,
  raw: string,
  keys: readonly string[],
): Readonly<T> {
  const parsed: unknown = parseYaml(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file}: not a YAML mapping`);
  }
  const data = parsed as Record<string, unknown>;
  requireKeys(file, data, keys);
  assertContent(file, data, "");
  return Object.freeze(fillValue(file, data) as T);
}

/** Split a markdown file's leading `---` front matter from its body. */
function parseFrontMatter(
  file: string,
  raw: string,
): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) throw new Error(`${file}: missing front matter block`);
  const data: unknown = parseYaml(match[1]!);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${file}: front matter is not a mapping`);
  }
  return {
    data: data as Record<string, unknown>,
    body: raw.slice(match[0].length),
  };
}

/** Parse a document: front matter for the meta, `##`-sections for the copy. */
function document(file: string, raw: string): Readonly<DocumentPage> {
  const { data, body } = parseFrontMatter(file, raw);
  requireKeys(file, data, [
    "metaTitle",
    "description",
    "eyebrow",
    "title",
    "summary",
    "updated",
    "mirror",
  ]);
  assertContent(file, data, "");
  const front = fillValue(file, data) as unknown as PageMeta & {
    updated: string;
    mirror: MirrorMeta;
  };
  const { intro, sections } = splitSections(parseMarkdown(fill(file, body)));
  if (intro.length > 0) {
    throw new Error(`${file}: text before the first "## " section`);
  }
  if (sections.length === 0) throw new Error(`${file}: no "## " sections`);
  return Object.freeze({
    ...front,
    sections: sections.map((section) => ({
      title: section.title,
      paragraphs: section.blocks.map((block) => {
        if (block.kind !== "paragraph") {
          throw new Error(
            `${file}: section "${section.title}" holds a ${block.kind} block; documents take paragraphs only`,
          );
        }
        return block.segments;
      }),
    })),
  });
}

// --- The bundles ------------------------------------------------------------

export const SITE: Readonly<SiteContent> = bundle(FILE.site, siteYaml, [
  "appSummary",
  "appTagline",
  "keyFacts",
  "createAccountLabel",
]);

export const MCP: Readonly<McpContent> = bundle(FILE.mcp, mcpYaml, [
  "capabilitiesHeading",
  "capabilities",
  "promptsHeading",
  "prompts",
  "securityHeading",
  "security",
]);

export const TERMS: Readonly<DocumentPage> = document(FILE.terms, termsMd);
export const PRIVACY: Readonly<DocumentPage> = document(
  FILE.privacy,
  privacyMd,
);
export const SUPPORT: Readonly<DocumentPage> = document(
  FILE.support,
  supportMd,
);

/** The FAQ's summary under the heading is the shared brand summary. */
export const FAQ: Readonly<FaqPage> = Object.freeze({
  ...bundle<Omit<FaqPage, "summary">>(FILE.faq, faqYaml, [
    "metaTitle",
    "description",
    "eyebrow",
    "title",
    "questions",
    "cta",
    "mirror",
  ]),
  summary: SITE.appSummary,
});

export const ABOUT: Readonly<AboutPage> = Object.freeze({
  ...bundle<Omit<AboutPage, "summary" | "keyFacts">>(FILE.about, aboutYaml, [
    "metaTitle",
    "description",
    "eyebrow",
    "title",
    "benefitsHeading",
    "factsHeading",
    "benefits",
    "cta",
    "mirror",
  ]),
  summary: SITE.appSummary,
});

export const ALTERNATIVES: Readonly<AlternativesPage> = bundle(
  FILE.alternatives,
  alternativesYaml,
  [
    "metaTitle",
    "description",
    "eyebrow",
    "title",
    "summary",
    "tableHeadings",
    "competitors",
    "pricingNote",
    "cta",
    "mirror",
  ],
);

export const AI: Readonly<AiPage> = bundle(FILE.ai, aiYaml, [
  "metaTitle",
  "description",
  "eyebrow",
  "title",
  "summary",
  "stepsHeading",
  "steps",
  "mcpConfigHeading",
  "mcpConfigJson",
  "connectNote",
  "webmcpHeading",
  "webmcpBody",
  "insightsHeading",
  "insightsSummary",
  "cta",
  "mirror",
]);

export const CONNECT: Readonly<ConnectPage> = bundle(
  FILE.connect,
  connectYaml,
  [
    "metaTitle",
    "description",
    "eyebrow",
    "title",
    "summary",
    "setupHeading",
    "baseAddressLabel",
    "oauthNote",
    "clients",
    "promptsHeading",
    "toolsHeading",
    "tools",
    "securityNote",
    "cta",
    "mirror",
  ],
);

export const MILEAGE_PAGE: Readonly<MileageRatesPage> = bundle(
  FILE.mileage,
  mileageRatesYaml,
  [
    "metaTitle",
    "description",
    "eyebrow",
    "title",
    "summary",
    "tableHeadings",
    "sourceNote",
    "cta",
    "mirror",
  ],
);

export const SCHEDULE_C_PAGE: Readonly<ScheduleCPage> = bundle(
  FILE.scheduleC,
  scheduleCYaml,
  [
    "metaTitle",
    "description",
    "eyebrow",
    "title",
    "summary",
    "tableHeadings",
    "notes",
    "sourceNote",
    "cta",
    "mirror",
  ],
);

export const LLMS: Readonly<LlmsContent> = bundle(FILE.llms, llmsYaml, [
  "corePages",
  "optionalPages",
]);

/** One Schedule C row: the seeded category, its form line, and its note. */
export interface ScheduleCRow {
  line: string;
  name: string;
  note: string;
}

/** Pair the seeded category names with the page's notes, by position, so the
 * table follows the CSV the seeder reads. */
export function pairRows(
  names: string[],
  notes: Array<{ line: string; note: string }>,
): ScheduleCRow[] {
  if (names.length !== notes.length) {
    throw new Error(
      `${FILE.scheduleC}: ${notes.length} notes for ${names.length} seeded categories`,
    );
  }
  return notes.map((note, index) => ({ ...note, name: names[index]! }));
}

/** The Schedule C table, in the order the categories are seeded. */
export function scheduleCRows(): ScheduleCRow[] {
  return pairRows(DEFAULT_CATEGORIES, SCHEDULE_C_PAGE.notes);
}

// --- The markdown mirrors ---------------------------------------------------

function wrap(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Segments back to markdown source, so a mirror keeps any inline link. */
function inlineMarkdown(segments: InlineSegment[]): string {
  return segments
    .map((segment) => {
      const text =
        segment.href === undefined
          ? segment.text
          : `[${segment.text}](${segment.href})`;
      return segment.bold ? `**${text}**` : text;
    })
    .join("");
}

/** The signup call every mirror but the documents closes with. */
function createAccountMarkdown(): string {
  return `[${SITE.createAccountLabel}](${SITE_URL}/login?mode=create)`;
}

function documentMarkdown(page: DocumentPage): string {
  const sections = page.sections
    .map(
      (section) =>
        `## ${section.title}\n\n${section.paragraphs
          .map((paragraph) => wrap(inlineMarkdown(paragraph)))
          .join("\n\n")}`,
    )
    .join("\n\n");
  return `# ${page.mirror.title}\n\n${page.summary}\n\nLast updated: ${page.updated}\n\n${sections}\n`;
}

/** Full markdown for /terms.md; mirrors the /terms page content. */
export function termsMarkdown(): string {
  return documentMarkdown(TERMS);
}

/** Full markdown for /privacy.md; mirrors the /privacy page content. */
export function privacyMarkdown(): string {
  return documentMarkdown(PRIVACY);
}

/** Full markdown for /support.md; mirrors the /support page content. */
export function supportMarkdown(): string {
  return documentMarkdown(SUPPORT);
}

/** Full markdown for /about.md. Mirrors the /about page content. */
export function aboutMarkdown(): string {
  const benefits = ABOUT.benefits
    .map((benefit) => `- **${benefit.title}** — ${wrap(benefit.body)}`)
    .join("\n");
  const facts = SITE.keyFacts.map((fact) => `- ${wrap(fact)}`).join("\n");
  return `# ${ABOUT.mirror.title}\n\n${SITE.appSummary}\n\n${SITE.appTagline}.\n\n## ${ABOUT.benefitsHeading}\n\n${benefits}\n\n## ${ABOUT.factsHeading}\n\n${facts}\n\n${ABOUT.mirror.footer}\n`;
}

/** Full markdown for /faq.md; mirrors the /faq page content. */
export function faqMarkdown(): string {
  const questions = FAQ.questions
    .map((faq) => `## ${faq.question}\n\n${wrap(faq.answer)}`)
    .join("\n\n");
  return `# ${FAQ.mirror.title}\n\n${SITE.appSummary}\n\n${questions}\n\n${createAccountMarkdown()}. ${FAQ.mirror.footer}\n`;
}

/** Full markdown for /alternatives.md. Mirrors the /alternatives page. */
export function alternativesMarkdown(): string {
  const competitors = ALTERNATIVES.competitors
    .map(
      (row) =>
        `- **${row.app}** (${row.site}): ${wrap(row.bestFor)} Pricing: ${wrap(row.pricing)} Tax-filing focus: ${wrap(row.taxFiling)}`,
    )
    .join("\n");
  return `# ${ALTERNATIVES.mirror.title}\n\n${ALTERNATIVES.summary}\n\n## ${ALTERNATIVES.mirror.heading}\n\n${competitors}\n\n${ALTERNATIVES.pricingNote}\n\n${ALTERNATIVES.mirror.footer}\n\n${createAccountMarkdown()}.\n`;
}

/** Full markdown for /ai.md; mirrors the /ai page content. */
export function aiMarkdown(): string {
  const capabilities = MCP.capabilities
    .map((item) => `- **${item.title}** — ${wrap(item.body)}`)
    .join("\n");
  const steps = AI.steps
    .map(
      (step, index) => `${index + 1}. **${step.title}** — ${wrap(step.body)}`,
    )
    .join("\n");
  const prompts = MCP.prompts.map((prompt) => `- ${prompt}`).join("\n");
  return `# ${AI.mirror.title}\n\n${AI.summary}\n\n## ${MCP.capabilitiesHeading}\n\n${capabilities}\n\n## ${AI.stepsHeading}\n\n${steps}\n\n## ${AI.insightsHeading}\n\n${wrap(AI.insightsSummary)}\n\n## ${AI.mirror.promptsHeading}\n\n${prompts}\n\n## ${MCP.securityHeading}\n\n${MCP.security}\n\n${createAccountMarkdown()}. ${AI.mirror.footer}\n`;
}

/** Full markdown for /connect.md; mirrors the /connect page content. */
export function connectMarkdown(): string {
  const tools = CONNECT.tools
    .map(
      (tool) =>
        `| \`${tool.name}\` | ${tool.writes ? "yes" : "no"} | ${tool.what} |`,
    )
    .join("\n");
  const clients = CONNECT.clients
    .map((client) => {
      const steps = client.steps
        .map((step, index) => `${index + 1}. ${step}`)
        .join("\n");
      const code = client.code
        ? `\n\n\`\`\`${client.code.lang}\n${client.code.body}\n\`\`\``
        : "";
      const note = client.note ? `\n\n${client.note}` : "";
      return `### ${client.name}\n\n${steps}${code}${note}`;
    })
    .join("\n\n");
  return `# ${CONNECT.mirror.title}\n\n${CONNECT.summary}\n\n${CONNECT.mirror.intro}\n\n## ${CONNECT.toolsHeading}\n\n| Tool | Writes | What it does |\n| --- | --- | --- |\n${tools}\n\n## ${CONNECT.setupHeading}\n\n${clients}\n\n## ${MCP.securityHeading}\n\n${MCP.security}\n\n${CONNECT.mirror.footer}\n`;
}

/** Full markdown for /mileage-rates.md; mirrors the /mileage-rates page. */
export function mileageRatesMarkdown(): string {
  const rows = mileageRateRows();
  const table = [
    `| ${MILEAGE_PAGE.tableHeadings.join(" | ")} |`,
    `| ${MILEAGE_PAGE.tableHeadings.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) =>
        `| ${row.period} | $${row.business} | $${row.medical} | $${row.moving} | $${row.charity} |`,
    ),
  ].join("\n");
  return `# ${MILEAGE_PAGE.mirror.title}\n\n> ${wrap(MILEAGE_PAGE.summary)}\n\n${wrap(MILEAGE_PAGE.mirror.explanation)}\n\n${table}\n\n${mileageSourceMarkdown()}\n`;
}

/** The mirror's longer mileage attribution: the page's note plus the current
 * period, which only the mirror names. */
function mileageSourceMarkdown(): string {
  return MILEAGE_PAGE.mirror.footer;
}

/** Full markdown for /schedule-c-categories.md; mirrors the page. */
export function scheduleCCategoriesMarkdown(): string {
  const table = [
    `| ${SCHEDULE_C_PAGE.tableHeadings.join(" | ")} |`,
    `| ${SCHEDULE_C_PAGE.tableHeadings.map(() => "---").join(" | ")} |`,
    ...scheduleCRows().map(
      (row) => `| ${row.line} | ${row.name} | ${row.note} |`,
    ),
  ].join("\n");
  return `# ${SCHEDULE_C_PAGE.mirror.title}\n\n> ${wrap(SCHEDULE_C_PAGE.summary)}\n\n${wrap(SCHEDULE_C_PAGE.mirror.intro)}\n\n${table}\n\n${wrap(SCHEDULE_C_PAGE.mirror.footer)}\n`;
}

/** The /llms.txt file: a curated overview for LLM retrieval, per llmstxt.org. */
export function llmsTxt(): string {
  const facts = SITE.keyFacts.map((fact) => `- ${wrap(fact)}`).join("\n");
  const links = (
    pages: Array<{ title: string; url: string; blurb?: string }>,
  ): string =>
    pages
      .map(
        (page) =>
          `- [${page.title}](${page.url})${page.blurb === undefined ? "" : `: ${page.blurb}`}`,
      )
      .join("\n");
  return `# Expense

> ${SITE.appSummary}

Key facts:

${facts}

## Core pages

${links(LLMS.corePages)}

## Optional

${links(LLMS.optionalPages)}
`;
}
