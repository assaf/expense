/**
 * Markdown for Agents: a public page asked for with `Accept: text/markdown`
 * answers with that page's markdown representation in place of the HTML
 * document (Cloudflare's "Markdown for Agents", RFC 9110 content
 * negotiation). Browsers send text/html and keep getting HTML, so the page
 * itself is unchanged for them.
 *
 * Two ways to the same text stay: an agent that knows the llmstxt.org
 * convention asks for `/about.md`, and one that negotiates asks `/about` with
 * the header. Both bodies come from the same builder in ~/lib/content.server,
 * so they cannot drift.
 *
 * Only pages with an HTML page AND a markdown builder are listed. The
 * middleware runs before the session gate, so a path that is not public must
 * never appear here: it would answer with content the gate exists to withhold.
 */
import {
  aboutMarkdown,
  aiMarkdown,
  alternativesMarkdown,
  changelogMarkdown,
  connectMarkdown,
  faqMarkdown,
  landingMarkdown,
  mileageRatesMarkdown,
  privacyMarkdown,
  productFactsMarkdown,
  scheduleCCategoriesMarkdown,
  supportMarkdown,
  termsMarkdown,
} from "~/lib/content.server";

/** Page path -> its markdown representation. */
const MARKDOWN_PAGES: Record<string, () => string> = {
  "/": landingMarkdown,
  "/about": aboutMarkdown,
  "/ai": aiMarkdown,
  "/alternatives": alternativesMarkdown,
  "/changelog": changelogMarkdown,
  "/connect": connectMarkdown,
  "/faq": faqMarkdown,
  "/mileage-rates": mileageRatesMarkdown,
  "/privacy": privacyMarkdown,
  "/product-facts": productFactsMarkdown,
  "/schedule-c-categories": scheduleCCategoriesMarkdown,
  "/support": supportMarkdown,
  "/terms": termsMarkdown,
};

/** The paths this module can negotiate, for the tests that keep the map and
 * the public page list in step. */
export const NEGOTIATED_PATHS = Object.keys(MARKDOWN_PAGES);

/** Does this path answer in two representations? The middleware asks so it
 * can add `Vary: Accept` to the HTML one as well. */
export function negotiatesPage(pathname: string): boolean {
  return MARKDOWN_PAGES[pathname] !== undefined;
}

/** Does the request ask for markdown? Only an explicit `text/markdown` with a
 * non-zero q-value counts: browsers never send it, and a bare wildcard (curl,
 * an uptime check) accepts anything, so it must keep getting the HTML
 * document. */
export function wantsMarkdown(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return false;
  return accept.split(",").some((part) => {
    const [mediaType, ...params] = part
      .split(";")
      .map((p) => p.trim().toLowerCase());
    if (mediaType !== "text/markdown") return false;
    const q = params.find((param) => param.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** `x-markdown-tokens` is an estimate, not a tokenizer: the four-characters-
 * per-token rule of thumb, rounded up, which is how Cloudflare reports it. */
function tokenEstimate(body: string): number {
  return Math.ceil(body.length / 4);
}

/** The negotiated markdown response, or null when the request keeps its HTML:
 * no markdown asked for, or no representation for this path. */
export function negotiateMarkdown(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (!wantsMarkdown(request)) return null;
  const page = MARKDOWN_PAGES[new URL(request.url).pathname];
  if (page === undefined) return null;
  const body = page();
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, s-maxage=600, stale-while-revalidate=86400",
      // The URL has two representations now, so a shared cache must key on
      // the header that picks between them.
      Vary: "Accept",
      "x-markdown-tokens": String(tokenEstimate(body)),
    },
  });
}
