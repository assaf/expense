import { useEffect } from "react";
import { Analytics } from "@vercel/analytics/react";
import type { LinksFunction } from "react-router";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useNavigation,
  useRouteError,
  useRouteLoaderData,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import "~/global.css";
import { CommandMenu } from "~/components/command-palette";
import { ShortcutHints } from "~/components/shortcut-hints";
import {
  loginRedirect,
  resolveSessionUser,
  userContext,
} from "~/lib/auth.server";
import { readReports } from "~/lib/db/reports";
import { discoveryLinks, securityHeaders } from "~/lib/seo-content";
import { umamiConfig } from "~/lib/umami.server";
import { useSession } from "~/lib/use-session";
import type { Route } from "./+types/root";

/** Inline script that runs before first paint; applies the `dark` class
 * based on `prefers-color-scheme` and listens for live system changes.
 * Exported so the parse contract in test/inline-scripts.test.ts can catch
 * a malformed edit: this script failing to parse silently kills dark mode
 * app-wide (it is the only thing that toggles the class). */
export const THEME_SCRIPT = `
(() => {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  function apply(e) {
    document.documentElement.classList.toggle("dark", e.matches);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", e.matches ? "#0f172a" : "#ffffff");
  }
  apply(mq);
  mq.addEventListener("change", apply);
})();
`;

/** Public marketing/SEO pages (plus their markdown mirrors like /faq.md). */
const PUBLIC_PAGES: Record<string, true> = {
  "/about": true,
  "/ai": true,
  "/connect": true,
  "/faq": true,
  "/mileage-rates": true,
  "/schedule-c-categories": true,
  "/product-facts": true,
  "/alternatives": true,
  "/privacy": true,
  "/terms": true,
  "/support": true,
  "/changelog": true,
  // /auth.md describes agent authentication (the Auth.md convention). The
  // gate strips the .md suffix, so this entry is what opens it; /auth itself
  // has no route and falls through to the 404 page.
  "/auth": true,
  "/llms.txt": true,
};

/** The path the gate judges a request by. React Router appends `.data` to
 * loader fetches during client-side navigation (e.g. /about.data for a Link
 * click on /about) and the marketing pages publish `.md` mirrors, so both
 * suffixes come off and the page path is what decides. The root `_index`
 * layout index route is served from `/_` for its data URL (`/_.data`), so
 * that maps to `/` too. */
function gatePath(pathname: string): string {
  let path = pathname;
  if (path.endsWith(".md")) path = path.slice(0, -3);
  if (path.endsWith(".data")) path = path.slice(0, -5);
  return path === "/_" ? "/" : path;
}

/** Resource routes that authenticate themselves, so they have to stay
 * reachable without a session: the cron and webhook secrets, the MCP bearer,
 * the PKCE OAuth endpoints and the discovery documents. A resource route used
 * to be exempt from the gate by accident, because React Router does not run an
 * ancestor loader for one. Now that the gate is middleware it runs for them
 * too, so each exemption is declared here; a self-gating route missing from
 * this list gets bounced to /login, which for the OAuth endpoints would break
 * the flow (a token request carries no cookie). */
const SELF_GATED_PATHS: Record<string, true> = {
  "/mcp": true,
  "/mcp/server-card": true,
  "/sign-out": true,
  "/api/session": true,
  "/api/smoke": true,
  "/api/inbound-cron": true,
  "/api/email-connections-cron": true,
  "/api/email-connections-push": true,
  "/api/email-connections-gmail-push": true,
  "/api/inbound-push": true,
  "/api/dev-email-drain": true,
};
const SELF_GATED_PREFIXES = ["/oauth/", "/.well-known/"];

/** Paths reachable without a session: the landing page, the auth flows (the
 * emailed verify links carry their own credential), the public marketing
 * pages, and the routes that gate themselves. */
function isGateExempt(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/login") ||
    path.startsWith("/onboarding") ||
    path.startsWith("/reset-password") ||
    path.startsWith("/unsubscribe") ||
    path.startsWith("/receipts-email-verify") ||
    path.startsWith("/verify-email") ||
    // The OAuth redirect targets must be reachable signed-out (the provider
    // bounces the user's browser there mid-flow) and the connect entry routes
    // serve the anonymous onboarding path; all self-gate (AUTH-FLOW-1: new
    // OAuth routes must be added here).
    path === "/connect-fastmail" ||
    path === "/fastmail-oauth-callback" ||
    path === "/connect-gmail" ||
    path === "/gmail-oauth-callback" ||
    PUBLIC_PAGES[path] === true ||
    SELF_GATED_PATHS[path] === true ||
    SELF_GATED_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

/** The session gate, as route middleware rather than loader code. Middleware
 * runs for every matched route, including the resource routes that never run
 * an ancestor loader, so the gate sees them all, and the user it resolves
 * travels to the route on `context` instead of being resolved again. It runs
 * before the loader, so an anonymous request to a private path is redirected
 * without any route work. */
const authGate: Route.MiddlewareFunction = async (
  { request, context },
  next,
) => {
  // Diagnostic: one line per request naming the caller. The platform's log
  // stream records the path and status but no user agent and no client IP, so
  // an automated client polling a public path is otherwise unattributable.
  // Off unless REQUEST_TRACE is set, so production pays nothing for it.
  if (process.env.REQUEST_TRACE) {
    const agent = request.headers.get("user-agent") ?? "";
    const ip = request.headers.get("x-forwarded-for") ?? "";
    console.info(
      `[trace] ${request.method} ${new URL(request.url).pathname} ua="${agent}" ip="${ip}"`,
    );
  }
  const user = await resolveSessionUser(context, request);
  if (!user && !isGateExempt(gatePath(new URL(request.url).pathname))) {
    throw loginRedirect(request);
  }
  await next();
};

export const middleware: Route.MiddlewareFunction[] = [authGate];

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const path = gatePath(url.pathname);
  // Public paths get neither the user nor the palette's report names, because
  // those pages are shared-cached (marketingPageHeaders) and their document
  // must be identical for every visitor. `deferredSession` tells the client
  // shell to resolve them from /api/session after hydration instead, so a
  // signed-in visitor still gets the palette and the "Dashboard" chrome.
  const deferredSession = isGateExempt(path);
  const user = deferredSession ? undefined : context.get(userContext);
  // Report names feed the palette's export submenu (same 5-min cache the
  // export page uses; acceptable per-navigation cost).
  const reportNames = user
    ? (await readReports(user.accountId)).map((r) => r.name)
    : [];
  return {
    user: user ? { id: user.id } : null,
    reportNames,
    deferredSession,
    // Public values (the tag is public HTML), resolved server-side so the
    // client bundle never imports env.ts (it touches node:fs).
    umami: umamiConfig,
    // Clickjacking denial is a real HTTP header from the route's headers()
    // export below, never from this loader data object.
  };
}

/** The root loader reads nothing from the query string (user, report
 * names, Umami config), so a search-param-only change (any page's local
 * UI state in the URL) skips the refetch. Real navigations — a different
 * path, or an action — still revalidate as usual. */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (
    currentUrl.pathname === nextUrl.pathname &&
    currentUrl.search !== nextUrl.search
  ) {
    return false;
  }
  return defaultShouldRevalidate;
}

/**
 * Clickjacking defense plus the agent discovery links on every HTML response
 * (see ~/lib/seo-content for both sets). The loader's `headers` key is inert
 * loader data; only this function emits real HTTP headers, and React Router
 * merges them with the child route's headers() (e.g. the marketing
 * Cache-Control) — except that a child's own `headers` export replaces this
 * one, which is why the shared helpers exist and the pages that declare
 * headers spread them in. HSTS is set by the platform: Vercel emits
 * strict-transport-security for production domains.
 */
export function headers(): HeadersInit {
  return {
    ...securityHeaders(),
    ...discoveryLinks(),
  };
}

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Expense — free expense tracking for tax season" },
    {
      name: "description",
      content:
        "Expense reads your receipts — snap a photo, paste a screenshot, or forward a receipt email — and organizes them into IRS Schedule C categories and reports for tax season.",
    },
    // Social sharing defaults (og:site_name, og:locale, og:type,
    // twitter:card, theme-color) live as static tags in the root <head>;
    // route meta arrays replace (not merge) parent meta in React Router, so
    // only per-page values (title, description, canonical, og:image) belong
    // here. The landing page overrides this title/description.
  ];
}

export const links: LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  {
    rel: "icon",
    href: "/logo-icon-192.png",
    type: "image/png",
    sizes: "192x192",
  },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  {
    rel: "apple-touch-icon-precomposed",
    href: "/apple-touch-icon-precomposed.png",
  },
  { rel: "manifest", href: "/manifest.json" },
];

/** Corner marker for the dev server: a small green DEV tag pinned to the
 * top-left of the viewport, fixed so it survives scrolling. Dev-only by
 * NODE_ENV gate (tests and production builds render nothing), so
 * screenshot baselines and prod traffic never see it. Informational
 * chrome: aria-hidden and pointer-events-none, it never blocks the corner
 * or enters the a11y tree. Exported for test/dev-badge.test.tsx. */
export function DevBadge() {
  if (process.env.NODE_ENV !== "development") return null;
  return (
    <div
      aria-hidden="true"
      data-dev-badge
      className="pointer-events-none fixed left-0 top-0 z-[90] select-none rounded-br-md bg-green-600 px-1.5 py-0.5 text-[10px] font-bold leading-4 tracking-wider text-white dark:bg-green-500"
    >
      DEV
    </div>
  );
}

export default function App() {
  const navigation = useNavigation();
  const { umami } = useRouteLoaderData<typeof loader>("root") ?? {};
  // The session comes with the root loader on app pages and from
  // /api/session after hydration on the shared-cached public ones (see
  // useSession), so the shell needs no special case for either.
  const { user, reportNames } = useSession();
  useEffect(() => {
    if (!user) return;
    // Link this session's pageviews/events to the signed-in user. Safe even
    window.umami?.identify?.({ id: user.id });
    // WebMCP experiment: expose the read tools to browser agents when the
    // browser has the API (Chrome 149+ origin trial); no-op elsewhere.
    // Dynamic import keeps the tool catalog (and zod) out of the main
    // bundle, and the presence check avoids even the chunk fetch for
    // browsers where the module would be a silent no-op.
    if ("modelContext" in document) {
      void import("~/lib/webmcp").then((m) => m.registerWebMcpTools());
    }
  }, [user]);
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Global, page-agnostic metadata. Route-level meta arrays replace
        (not merge) parent meta in React Router, so these apply everywhere
        while each page's meta() owns its title/description/canonical. */}
        <meta property="og:site_name" content="Expense" />
        <meta property="og:locale" content="en_US" />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="theme-color" content="#ffffff" />
        <Meta />
        <Links />
        {/* Umami is production-only: no tracking script (or identify
        calls) in dev; dev traffic would pollute the stats. This is the ONE
        Umami integration: app-wide pageviews, conversion events (login
        signup), and export-download events; the values come from the
        loader (env-resolved, see umami.server.ts), so deployments without
        the env vars simply don't track. Pageview URLs exclude the query
        string: emailed links carry single-use tokens in ?token=, and the
        tracker must never record them. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {process.env.NODE_ENV === "production" && umami?.scriptUrl ? (
          <script
            defer
            src={umami.scriptUrl}
            data-website-id={umami.websiteId}
            data-exclude-search="true"
          ></script>
        ) : null}
        <meta name="msvalidate.01" content="E606D66AC502D88D7B6E62982FF6CD98" />
      </head>
      <body>
        {navigation.state !== "idle" ? (
          <div
            role="progressbar"
            aria-label="Loading"
            className="fixed inset-x-0 top-0 z-[90] h-0.5 animate-pulse bg-teal-600/80 dark:bg-teal-400/80"
          />
        ) : null}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-gray-900 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:outline-none dark:focus:bg-gray-100 dark:focus:text-gray-900"
        >
          Skip to main content
        </a>
        <DevBadge />
        <Outlet />
        {user ? <CommandMenu reportNames={reportNames} /> : null}
        {user ? <ShortcutHints /> : null}
        <ScrollRestoration />
        {/* Emailed links carry single-use tokens in ?token= (reset,
        verification, sender claim). Strip the query so the tracker records
        paths only, never credentials. */}
        {process.env.NODE_ENV === "production" ? (
          <Analytics
            beforeSend={(event) => ({
              ...event,
              url: event.url.split(/[?#]/)[0],
            })}
          />
        ) : null}
        <Scripts />
      </body>
    </html>
  );
}

/** Render the error boundary's message: statusText when present, else a
 * data payload that may be a string or a JSON envelope ({ error }). The
 * old String(data) rendered JSON envelopes as "[object Object]". */
function boundaryMessage(error: unknown): string {
  if (!isRouteErrorResponse(error)) return "Something went wrong.";
  if (error.statusText) return error.statusText;
  const data: unknown = error.data;
  if (typeof data === "string" && data) return data;
  if (data && typeof data === "object") {
    const envelope = data as { error?: unknown; message?: unknown };
    if (typeof envelope.error === "string" && envelope.error) {
      return envelope.error;
    }
    if (typeof envelope.message === "string" && envelope.message) {
      return envelope.message;
    }
  }
  return `Request failed (${error.status}).`;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = boundaryMessage(error);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#ffffff" />
        <title>{`${status} — Expense`}</title>
        <Links />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <main className="mx-auto flex max-w-xl flex-col items-center gap-2 px-4 py-24">
          <h1 className="text-4xl font-bold text-red-600 dark:text-red-400">
            {status}
          </h1>
          <p className="text-gray-500 dark:text-gray-400">{String(message)}</p>
          <a
            href="/expenses"
            className="mt-4 text-blue-600 underline dark:text-blue-400"
          >
            Back to expenses
          </a>
        </main>
        <Scripts />
      </body>
    </html>
  );
}
