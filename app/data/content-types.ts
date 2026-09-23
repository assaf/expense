import type { InlineSegment } from "~/lib/markdown";

/**
 * The shape of the public copy under `app/data/`: one file per page, parsed
 * by `~/lib/content.server` and handed to the routes as loader data and to
 * the `.md` / `.txt` mirror builders. The types live apart from the parser
 * so a route and a component can both name them. Nothing here has a runtime
 * cost: the only import is a type.
 *
 * A mirror (`/terms.md`, `/llms.txt`, …) is built from the same fields the
 * page renders, so the two can't drift. Where a mirror carries text no page
 * shows — a closing attribution, an extra paragraph — it lives in `mirror`.
 */

/** Front-matter fields every page's content file carries. */
export interface PageMeta {
  /** The document title tag, with `{{tokens}}` for computed values. */
  metaTitle: string;
  /** The meta description, likewise. */
  description: string;
  /** Small uppercase label above the heading ("About", "Privacy", …). */
  eyebrow: string;
  /** The page's display heading. */
  title: string;
  /** The summary paragraph under the heading. */
  summary: string;
}

/** Text the markdown mirror carries and the page does not. */
export interface MirrorMeta {
  /** The mirror's H1. */
  title: string;
  /** A mirror-only section heading, where the page has no equivalent. */
  heading?: string;
  /** A mirror-only paragraph between the summary and the body. */
  intro?: string;
  /** The mirror's closing text, where each builder places it. */
  footer?: string;
  /** A mirror-only section heading that differs from the page's. */
  promptsHeading?: string;
}

/** The call-to-action panel's copy; layout (icon, links, classes) stays in
 * the route. Declared here rather than exported: every page names it through
 * its own bundle's `cta` field, and nothing imports the shape directly. */
interface CtaContent {
  heading: string;
  body: string;
  /** Defaults to "Create your account" in `MarketingCta`. Every visitor sees
   * it: the marketing pages are shared-cached, so the panel cannot vary by
   * session. A signed-in visitor who follows it lands on the expense list,
   * because /login redirects them there. */
  primaryLabel?: string;
  /** Rendered only when the route also passes `secondaryHref`. */
  secondaryLabel?: string;
}

/** One block of a document section: a paragraph, or a bullet list. Documents
 * are prose, so tables and headings stay out of them (a `## ` line is the
 * section boundary, which is why `splitSections` owns it). */
export type DocumentBlock =
  | { kind: "paragraph"; segments: InlineSegment[] }
  | { kind: "bullets"; items: InlineSegment[][] };

/** A prose document: a `##`-sectioned markdown file with front matter. */
export interface DocumentPage extends PageMeta {
  /** The "last updated" date, shown by the page and the mirror. */
  updated: string;
  sections: Array<{ title: string; blocks: DocumentBlock[] }>;
  mirror: MirrorMeta;
}

/** `site.yaml`: brand copy shared by several pages and mirrors. */
export interface SiteContent {
  /** Multi-line on purpose: the mirrors carry its line breaks verbatim. */
  appSummary: string;
  appTagline: string;
  keyFacts: string[];
  /** The label on the mirrors' signup link. */
  createAccountLabel: string;
}

/** `about.yaml`. */
export interface AboutPage extends PageMeta {
  benefitsHeading: string;
  factsHeading: string;
  benefits: Array<{ title: string; body: string }>;
  cta: CtaContent;
  mirror: MirrorMeta & { footer: string };
}

/** `faq.yaml`. */
export interface FaqPage extends PageMeta {
  questions: Array<{ question: string; answer: string }>;
  cta: CtaContent;
  mirror: MirrorMeta & { footer: string };
}

/** `alternatives.yaml`. Two tables, because they answer two questions: how
 * Expense fits among the receipt apps, and, for the apps a self-employed filer
 * is pointed at, which ones read receipts out of a mailbox. Every cell about
 * another app is sourced to that vendor's own documentation, and `sources`
 * records the pages and the date they were read. */
export interface AlternativesPage extends PageMeta {
  tableHeadings: string[];
  competitors: Array<{
    app: string;
    site: string;
    bestFor: string;
    pricing: string;
    taxFiling: string;
  }>;
  pricingNote: string;
  inboxHeading: string;
  inboxNote: string;
  inboxTableHeadings: string[];
  inboxApps: Array<{
    app: string;
    site: string;
    price: string;
    inbox: string;
    scheduleC: string;
    mileage: string;
  }>;
  exampleHeading: string;
  exampleIntro: string;
  example: Array<{ step: string; what: string }>;
  mappingHeading: string;
  mapping: Array<{ email: string; lands: string }>;
  mappingNote: string;
  limitsHeading: string;
  limits: string[];
  sourcesHeading: string;
  sourcesNote: string;
  sources: Array<{ app: string; checked: string; urls: string[] }>;
  cta: CtaContent;
  mirror: MirrorMeta & { heading: string; footer: string };
}

/** `mcp.yaml`: the MCP copy /ai and /connect share, so the two pages can't
 * drift apart. */
export interface McpContent {
  capabilitiesHeading: string;
  capabilities: Array<{ title: string; body: string }>;
  promptsHeading: string;
  prompts: string[];
  securityHeading: string;
  security: string;
}

/** `ai.yaml`. */
export interface AiPage extends PageMeta {
  stepsHeading: string;
  steps: Array<{ title: string; body: string }>;
  webmcpHeading: string;
  webmcpBody: string;
  insightsHeading: string;
  insightsSummary: string;
  mcpConfigHeading: string;
  mcpConfigJson: string;
  connectNote: string;
  cta: CtaContent;
  mirror: MirrorMeta & { promptsHeading: string; footer: string };
}

/** `connect.yaml`. */
export interface ConnectPage extends PageMeta {
  setupHeading: string;
  baseAddressLabel: string;
  oauthNote: string;
  clients: Array<{
    id: string;
    name: string;
    /** Compact label for the client pills; falls back to `name`. */
    short?: string;
    steps: string[];
    code?: { lang: "sh" | "json" | "toml"; body: string };
    note?: string;
  }>;
  promptsHeading: string;
  toolsHeading: string;
  tools: Array<{ name: string; writes: boolean; what: string }>;
  securityNote: string;
  cta: CtaContent;
  mirror: MirrorMeta & { intro: string; footer: string };
}

/** `mileage-rates.yaml`. */
export interface MileageRatesPage extends PageMeta {
  tableHeadings: string[];
  /** The IRS attribution under the table, page and mirror. */
  sourceNote: string;
  cta: CtaContent;
  /** `explanation` is the mirror's lead line above the table: the page shows
   * the same ordering visually, so it never renders it. */
  mirror: MirrorMeta & { footer: string; explanation: string };
}

/** `schedule-c-categories.yaml`. Category names are NOT here: they come
 * from the seeded CSV, paired with these notes by index. */
export interface ScheduleCPage extends PageMeta {
  tableHeadings: string[];
  notes: Array<{ line: string; note: string }>;
  /** The IRS attribution under the table, page and mirror. */
  sourceNote: string;
  cta: CtaContent;
  mirror: MirrorMeta & { intro: string; footer: string };
}

/** `product-facts.yaml`: the fact sheet at /product-facts. Category names are
 * NOT here, for the same reason as the Schedule C page: they come from the
 * seeded CSV, so the line-item mapping the page publishes follows the list a
 * new account actually gets. */
export interface ProductFactsPage extends PageMeta {
  factsHeading: string;
  tableHeadings: string[];
  facts: Array<{ label: string; value: string }>;
  captureHeading: string;
  capture: Array<{ method: string; what: string }>;
  categoriesHeading: string;
  categoriesNote: string;
  pricingHeading: string;
  pricing: string[];
  cta: CtaContent;
  mirror: MirrorMeta & { footer: string };
}

/** What one changelog entry did to the product. */
export type ChangeType = "feature" | "improvement" | "fix";

/** One dated release in the changelog: the changes that shipped that day. */
export interface ChangelogRelease {
  /** The day the change shipped, "YYYY-MM-DD". */
  date: string;
  changes: Array<{ type: ChangeType; text: string }>;
}

/** `changelog.yaml`: the product changelog at /changelog. Entries are grouped
 * by the day they shipped rather than by version number: every push to main
 * deploys, so the date is the release.
 *
 * The entries are hand-written, and the file is append-mostly: a new note goes
 * under today's date, or under an existing date if the change shipped then.
 * `changelogReleases()` sorts them newest first, so the file's own order is
 * free, and validates what the page depends on (real dates, known types,
 * labels for each). */
export interface ChangelogPage extends PageMeta {
  /** The lead-in above the release list. */
  intro: string;
  /** The badge label per change type ("New", "Improved", "Fixed"). */
  typeLabels: Record<ChangeType, string>;
  releases: ChangelogRelease[];
  /** The signup panel that closes the page, on the marketing pages. */
  cta: CtaContent;
  /** `intro` is the mirror's own lead-in: the page shows the same words as
   * its hero summary, so the mirror carries them under the H1. */
  mirror: MirrorMeta & { intro: string; footer: string };
}

/** `llms.yaml`: the /llms.txt link hub. */
export interface LlmsContent {
  corePages: Array<{ title: string; url: string; blurb: string }>;
  optionalPages: Array<{ title: string; url: string; blurb?: string }>;
}

/** `warranty-policies.yaml`: the curated merchant coverage table, the one
 * data file here that is not public copy. Each entry is what a warranty
 * record for that merchant starts with, so it carries the pages the summary
 * was read from and the month it was checked: an entry with no source or no
 * `asOf` must not ship. `app/lib/warranty-policies.ts` matches a record's
 * merchant against these and renders the terms. */
export interface MerchantPolicy {
  /** Merchant name as the retailer writes it; matched as whole words. */
  merchant: string;
  /** Other names the retailer trades under ("America's Tire" for Discount
   * Tire), matched exactly like `merchant`. */
  aliases?: readonly string[];
  /** Coverage summary in the record's own voice, a sentence or two. */
  terms: string;
  /** The official pages the summary was taken from. */
  sources: readonly string[];
  /** The month the summary was last checked, "YYYY-MM". */
  asOf: string;
}
