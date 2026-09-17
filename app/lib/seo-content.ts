import { MILEAGE_RATES } from "~/data/mileage-rates";
import { formatRate, periodLabel } from "~/lib/mileage-rates";

/**
 * Site configuration, the shared meta helpers, and the computed mileage
 * helpers.
 *
 * The public copy itself lives in `app/data/`: one markdown or YAML content
 * file per page, parsed by `~/lib/content.server`, which the marketing routes
 * read as loader data and which the `.md` and `/llms.txt` mirrors are built
 * from. Edit the copy there, not here.
 *
 * Three things stay, because a content file must not own them:
 *
 * - The canonical URLs, the social card, and the support address, which the
 *   app itself points at (OAuth metadata, the email footer, the JSON-LD
 *   blocks, the account-security notice).
 * - `pageMeta` and `marketingPageHeaders`: the meta-tag shape and the cache
 *   contract every marketing page shares, so they can't drift apart.
 * - The mileage-rate helpers, computed from `app/data/mileage-rates.ts` (the
 *   same seed the app syncs into its master table), so the rate table and the
 *   "current rate" sentence a content file quotes can't go stale.
 */

export const SITE_URL = "https://expense.labnotes.org";

/** The public MCP endpoint (Streamable HTTP + OAuth): every install instruction points here. */
export const MCP_ENDPOINT = `${SITE_URL}/mcp`;

/** The social-card image shared by every marketing page's og:image. */
export const OG_IMAGE = `${SITE_URL}/screenshot-og.png`;

/** Early access is capped at this many accounts. The landing page counts how
 * many are claimed, and /product-facts and its mirror state the cap, so the
 * number lives here rather than in three places. */
export const EARLY_ACCESS_SPOTS = 100;

/** The one address the site publishes for itself: the support and policy
 * pages quote it as `{{supportEmail}}`, the User-Agent that identifies the app
 * to the map services carries it, and the sign-in change notice sends account
 * problems to it. Typed here so a change of address is one edit. */
export const SUPPORT_EMAIL = "assaf@labnotes.org";

/**
 * Clickjacking defense, on every HTML response. A route's own `headers`
 * export replaces its parent's rather than merging with it (React Router
 * hands the leaf's set to the response), so every route that declares headers
 * spreads this in: without it the page silently ships without frame-ancestors
 * (the marketing pages and the landing page did exactly that).
 */
export function securityHeaders(): Record<string, string> {
  return {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
  };
}

/**
 * Agent discovery from the response envelope, so a client learns where the
 * machine-readable documents are without reading the page (RFC 8288 rels; the
 * catalog rel is RFC 9727 §3). Every target resolves: the catalog is a
 * resource route, the card is the endpoint's own, and llms.txt is the LLM
 * overview. A page that has a markdown mirror also advertises it as
 * `rel="alternate"`, which is how the llms.txt v2 proposal says to point at
 * the markdown version of a page.
 */
export function discoveryLinks(mirror?: string): Record<string, string> {
  const links = [
    '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
    '</mcp/server-card>; rel="service-desc"; type="application/mcp-server-card+json"',
    '</llms.txt>; rel="describedby"; type="text/plain"',
  ];
  if (mirror) {
    links.push(`<${mirror}>; rel="alternate"; type="text/markdown"`);
  }
  return { Link: links.join(", ") };
}

/**
 * Cache-Control header shared by the marketing/SEO pages. These SSR
 * documents embed session-dependent loader data for signed-in visitors
 * (the root loader feeds the global command palette the account's report
 * names), so shared caches must never store them: the first signed-in hit
 * would otherwise pin personalized HTML for every visitor (MKT-CACHE-1).
 * Browsers revalidate on every request. `Vary: Accept` is here because these
 * pages have two representations: the HTML page and its `.md` mirror, whose
 * location `mirror` advertises as `rel="alternate"`.
 */
export function marketingPageHeaders(mirror?: string): Record<string, string> {
  return {
    ...securityHeaders(),
    ...discoveryLinks(mirror),
    Vary: "Accept",
    "Cache-Control": "private, max-age=0, must-revalidate",
  };
}

/** The standard meta tags every marketing/SEO page advertises: a title, a
 * description, a canonical link against its own path, and the og:* tags
 * social cards need (the static root head carries og:site_name, og:locale,
 * og:type, and twitter:card; route meta arrays replace, not merge, so each
 * page repeats only the per-page values). Shared by /about, /ai, /faq,
 * /alternatives, /mileage-rates, /schedule-c-categories, and /login so the
 * tag shape and the canonical URL pattern can't drift between pages. The
 * landing page opts out: its card copy is richer and hand-written. */
export function pageMeta(
  title: string,
  description: string,
  path: string,
): Array<
  | { title: string }
  | { name: "description"; content: string }
  | { tagName: "link"; rel: "canonical"; href: string }
  | { property: string; content: string }
> {
  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}${path}` },
    { property: "og:url", content: `${SITE_URL}${path}` },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:image", content: OG_IMAGE },
  ];
}

/** One IRS rate period aggregated across types, for the /mileage-rates
 * table and its markdown mirror. Rows come straight from MILEAGE_RATES
 * (the same seed the app syncs into its master table), newest first. */
export interface MileageRateRow {
  period: string;
  start: string;
  end: string;
  business: string;
  medical: string;
  moving: string;
  charity: string;
}

/** All rate periods, newest first. */
export function mileageRateRows(): MileageRateRow[] {
  const byPeriod = new Map<string, MileageRateRow>();
  for (const r of MILEAGE_RATES) {
    const key = `${r.startDate}|${r.endDate}`;
    const row = byPeriod.get(key) ?? {
      period: periodLabel(r.startDate, r.endDate),
      start: r.startDate,
      end: r.endDate,
      business: "",
      medical: "",
      moving: "",
      charity: "",
    };
    row[r.type] = formatRate(r.rate);
    byPeriod.set(key, row);
  }
  return [...byPeriod.values()].toSorted((a, b) =>
    b.start.localeCompare(a.start),
  );
}

function mileagePhrase(row: MileageRateRow): string {
  const [sy, ey] = [row.start.slice(0, 4), row.end.slice(0, 4)];
  if (sy === ey && row.start === `${sy}-01-01` && row.end === `${sy}-12-31`) {
    return `for ${sy}`;
  }
  const monthDay = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  return `from ${monthDay(row.start)} to ${monthDay(row.end)}, ${ey}`;
}

/** The current business/medical/charitable rates as one quotable sentence.
 * Composed from MILEAGE_RATES, not hand-written: when the IRS publishes new
 * rates (usually each December, plus mid-year changes), updating the data
 * file keeps this answer, the FAQ entry, and the page meta description true
 * without a copy edit. Content files quote it as `{{mileage}}`. */
export function currentMileageSummary(): string {
  const rows = mileageRateRows();
  const latest = rows[0]!;
  const prev = rows[1];
  const split =
    prev !== undefined && prev.end.slice(0, 4) === latest.end.slice(0, 4);
  const business = split
    ? `$${prev.business} per mile ${mileagePhrase(prev)}, then $${latest.business} per mile ${mileagePhrase(latest)}`
    : `$${latest.business} per mile ${mileagePhrase(latest)}`;

  const secondary = split
    ? `medical and moving moves run $${prev.medical} and then $${latest.medical} for the same dates`
    : `medical and moving moves run $${latest.medical}`;
  return `The IRS standard business mileage rate is ${business}; ${secondary}, and the charitable rate is fixed by statute at $${latest.charity}.`;
}
