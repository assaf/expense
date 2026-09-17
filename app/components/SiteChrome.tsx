import { Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { Logo } from "~/components/Logo";
import { useSignedIn } from "~/lib/use-signed-in";

/** The footer's link columns: what the site is, how to connect to it, the
 * reference pages, and the policy pages. */
const FOOTER_COLUMNS: SiteNavItem[][] = [
  [
    { label: "About", to: "/about" },
    { label: "Compare", to: "/alternatives" },
    { label: "FAQ", to: "/faq" },
  ],
  [
    { label: "AI", to: "/ai" },
    { label: "MCP", to: "/connect" },
  ],
  [
    { label: "Mileage", to: "/mileage-rates" },
    { label: "Categories", to: "/schedule-c-categories" },
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
  const signedIn = useSignedIn();
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
      <Logo link />
      <nav className="flex items-center gap-4 text-sm">
        <Button asChild variant="ghost" size="sm" className="ml-2">
          {signedIn ? (
            // The expenses list is "/" for a signed-in visitor (the landing
            // page is its anonymous face), which is also where the nav to
            // Settings and sign-out lives.
            <Link to="/">Dashboard</Link>
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
