import { useEffect } from "react";
import type { LinksFunction } from "react-router";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
  useRouteLoaderData,
} from "react-router";
import "~/global.css";
import { isAuthenticated, requireUser } from "~/lib/auth.server";
import type { Route } from "./+types/root";

/** Public marketing/SEO pages (plus their markdown mirrors like /faq.md). */
const PUBLIC_PAGES = new Set([
  "/about",
  "/ai",
  "/faq",
  "/alternatives",
  "/llms.txt",
]);

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // The home page (landing for anonymous visitors), the login route, the
  // inbound email webhook, the sender-verification page, and the public
  // marketing pages are open; everything else requires a session (the
  // webhook and the verify link carry their own credentials — the Resend
  // signature and the single-use emailed token).
  let path = url.pathname;
  if (path.endsWith(".md")) path = path.slice(0, -3);
  // React Router appends .data to loader fetches during client-side
  // navigation (e.g. /about.data for a Link click on /about) — match the
  // page path, not the fetch path, so public pages stay public.
  if (path.endsWith(".data")) path = path.slice(0, -5);
  const isPublic =
    path === "/" ||
    path.startsWith("/login") ||
    path.startsWith("/api/inbound-email") ||
    path.startsWith("/receipts-email-verify") ||
    path.startsWith("/verify-email") ||
    PUBLIC_PAGES.has(path);
  let user = null;
  if (isPublic) {
    // Anonymous visitors stay anonymous; signed-in users still get
    // identified (e.g. landing page views from a session).
    if (await isAuthenticated(request)) user = await requireUser(request);
  } else {
    user = await requireUser(request);
  }
  return { user: user ? { id: user.id } : null };
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
    // twitter:card, theme-color) live as static tags in the root <head> —
    // route meta arrays replace (not merge) parent meta in React Router, so
    // only per-page values (title, description, canonical, og:image) belong
    // here. The landing page overrides this title/description.
  ];
}

export const links: LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  {
    rel: "apple-touch-icon-precomposed",
    href: "/apple-touch-icon-precomposed.png",
  },
  { rel: "manifest", href: "/manifest.json" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
  },
];

export default function App() {
  const { user } = useRouteLoaderData<typeof loader>("root") ?? {};
  useEffect(() => {
    if (!user) return;
    // Link this session's pageviews/events to the signed-in user. Safe even
    // before the (deferred) script has run — identify is a no-op then.
    window.umami?.identify?.({ id: user.id });
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
        <meta name="theme-color" content="#111827" />
        <Meta />
        <Links />
        {/* Umami is production-only: no tracking script (or identify calls)
        in dev — dev traffic would pollute the stats. */}
        {process.env.NODE_ENV === "production" ? (
          <script
            defer
            src="https://cloud.umami.is/script.js"
            data-website-id="262a3181-12ef-46cb-902a-9bc2462413da"
          ></script>
        ) : null}
      </head>
      <body>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:outline-none"
        >
          Skip to main content
        </a>
        {process.env.NODE_ENV === "development" ? (
          <div className="pointer-events-none fixed left-3 top-3 z-50 rounded-md bg-green-600 px-2 py-0.5 text-xs font-bold tracking-wider text-white shadow">
            DEV
          </div>
        ) : null}
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = isRouteErrorResponse(error)
    ? error.statusText || error.data
    : "Something went wrong.";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${status} — Expense`}</title>
        <Links />
      </head>
      <body>
        <main className="mx-auto flex max-w-xl flex-col items-center gap-2 px-4 py-24">
          <h1 className="text-4xl font-bold text-red-600">{status}</h1>
          <p className="text-gray-500">{String(message)}</p>
          <a href="/" className="mt-4 text-blue-600 underline">
            Back to expenses
          </a>
        </main>
        <Scripts />
      </body>
    </html>
  );
}
