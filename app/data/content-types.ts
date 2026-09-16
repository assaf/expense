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
  /** Defaults to "Create your account" in `MarketingCta`. */
  primaryLabel?: string;
  /** Rendered only when the route also passes `secondaryHref`. */
  secondaryLabel?: string;
}

/** A prose document: a `##`-sectioned markdown file with front matter. */
export interface DocumentPage extends PageMeta {
  /** The "last updated" date, shown by the page and the mirror. */
  updated: string;
  sections: Array<{ title: string; paragraphs: InlineSegment[][] }>;
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

/** `alternatives.yaml`. */
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
  /** A mirror-only paragraph above the table. */
  explanation: string;
  /** The IRS attribution under the table, page and mirror. */
  sourceNote: string;
  cta: CtaContent;
  mirror: MirrorMeta & { footer: string };
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

/** `llms.yaml`: the /llms.txt link hub. */
export interface LlmsContent {
  corePages: Array<{ title: string; url: string; blurb: string }>;
  optionalPages: Array<{ title: string; url: string; blurb?: string }>;
}
