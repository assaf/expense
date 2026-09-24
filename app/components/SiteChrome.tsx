import { Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { Logo } from "~/components/Logo";
import { useSession } from "~/lib/use-session";

/** The footer's link columns: what the site is, the assistant, the reference
 * pages, and the policy pages. 4/2/3/3, because Changelog belongs with the
 * product pages rather than the reference ones: it describes the app, not a
 * lookup table. */
const FOOTER_COLUMNS: SiteNavItem[][] = [
  [
    { label: "About", to: "/about" },
    { label: "Compare", to: "/alternatives" },
    { label: "Facts", to: "/product-facts" },
    { label: "Changelog", to: "/changelog" },
  ],
  [
    { label: "AI", to: "/ai" },
    { label: "MCP", to: "/connect" },
  ],
  [
    { label: "Mileage", to: "/mileage-rates" },
    { label: "Categories", to: "/schedule-c-categories" },
    { label: "FAQ", to: "/faq" },
  ],
  [
    { label: "Privacy", to: "/privacy" },
    { label: "Terms", to: "/terms" },
    { label: "Support", to: "/support" },
  ],
];

/**
 * Site header + footer for the public marketing/SEO pages (the landing page
 * and the /about, /faq, /alternatives SitePage). Both pages render the same
 * chrome: the wordmark header with a "Sign in" button (a "Dashboard" link to
 * the expenses list once the visitor has a session) and the brand +
 * copyright footer with the link columns in FOOTER_COLUMNS, so the chrome
 * lives here and every public page just mounts SiteHeader + SiteFooter.
 */

/** One link in a footer column. */
interface SiteNavItem {
  label: string;
  to: string;
}

/** One footer link: a client-side <Link>, so a click stays in the app. */
function SiteNavLink({ item }: { item: SiteNavItem }) {
  return (
    <Link
      to={item.to}
      className="rounded-md text-gray-500 dark:text-gray-400 transition-colors hover:text-ink dark:hover:text-gray-100"
    >
      {item.label}
    </Link>
  );
}

export function SiteHeader() {
  const { user } = useSession();
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
      <Logo link />
      <nav className="flex items-center gap-4 text-sm">
        {/* The header's one action wears the accent fill (the same blue as
            the sign-in submit and the connect chooser), at the logo's own
            height: a ghost link in the corner read as stray chrome rather
            than the thing to click. */}
        <Button
          asChild
          variant="ghost"
          size="md"
          className="ml-2 bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
        >
          {/* The document is the same for every visitor (these pages are
              shared-cached), so the session arrives from /api/session after
              hydration: the link paints as "Sign in" and flips to the app's
              own home for a visitor who has one. */}
          {user ? (
            <Link to="/expenses">Dashboard</Link>
          ) : (
            <Link to="/login">Sign in</Link>
          )}
        </Button>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-gray-100 dark:border-gray-700">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-8 px-4 py-8 sm:px-6 lg:flex-row lg:items-start lg:justify-between lg:gap-12">
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
          <Logo icon />
          {/* One span, so the credit wraps as a phrase rather than as
           * "Stewarded by" plus a link that can land on its own line. */}
          <span className="whitespace-nowrap">
            © {new Date().getFullYear()} · Stewarded by{" "}
            <a href="https://labnotes.org">Assaf Arkin</a>
          </span>
        </div>
        <nav
          aria-label="Site pages"
          className="grid grid-cols-2 gap-x-10 gap-y-6 sm:grid-cols-4"
        >
          {FOOTER_COLUMNS.map((column, index) => (
            <ul key={index} className="flex flex-col gap-2 text-sm">
              {column.map((item) => (
                <li key={item.label}>
                  <SiteNavLink item={item} />
                </li>
              ))}
            </ul>
          ))}
        </nav>
      </div>
    </footer>
  );
}
