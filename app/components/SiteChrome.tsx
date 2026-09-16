import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";
import { cn } from "cn";
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

/** The one off-site link, so it sits with the credit rather than in a column
 * of site pages. */
const FOOTER_BLOG: SiteNavItem = {
  label: "Blog",
  to: "https://labnotes.org",
  external: true,
};

/**
 * Site header + footer for the public marketing/SEO pages (the landing page
 * and the /about, /faq, /alternatives SitePage). Both pages render the same
 * chrome: the wordmark header with a "Sign in" button (a "Dashboard" link to
 * the expenses list once the visitor has a session) and the brand +
 * copyright footer with the link columns in FOOTER_COLUMNS, so the chrome
 * lives here and every public page just mounts SiteHeader + SiteFooter.
 */

/** One entry in a site header/footer nav. External links render as real
 * `<a>` (target=_blank) with a small arrow affordance. */
interface SiteNavItem {
  label: string;
  to: string;
  external?: boolean;
  /** Hide on small screens (header nav only; it is already crowded). */
  hideOnMobile?: boolean;
}

/** One nav link: an internal <Link>, or an external <a> with an arrow. */
function SiteNavLink({ item }: { item: SiteNavItem }) {
  const classes = cn(
    "rounded-md text-gray-500 dark:text-gray-400 transition-colors hover:text-ink dark:hover:text-gray-100",
    item.external && "inline-flex items-center gap-1",
    item.hideOnMobile && "hidden sm:inline-flex",
  );
  if (item.external) {
    return (
      <a href={item.to} target="_blank" rel="noreferrer" className={classes}>
        {item.label}
        <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
      </a>
    );
  }
  return (
    <Link to={item.to} className={classes}>
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
          <Logo icon /> · © {new Date().getFullYear()} · Stewarded by{" "}
          <a href="https://labnotes.org">Assaf Arkin</a> ·{" "}
          <SiteNavLink item={FOOTER_BLOG} />
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
