import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";
import { cn } from "~/lib/cn";
import { Button } from "~/components/ui/Button";
import { Logo } from "~/components/Logo";
import { BLOG_URL } from "~/lib/seo-content";

const FOOTER_NAV: SiteNavItem[] = [
  { label: "About", to: "/about" },
  { label: "AI", to: "/ai" },
  { label: "FAQ", to: "/faq" },
  { label: "Compare", to: "/alternatives" },
  { label: "Blog", to: BLOG_URL, external: true },
];

/**
 * Site header + footer for the public marketing/SEO pages (the landing page
 * and the /about, /faq, /alternatives SitePage). Both pages render the same
 * chrome — the wordmark header with a "Sign in" button and the
 * brand + copyright footer with the fixed FOOTER_NAV link list — so the
 * chrome lives here and every public page just mounts SiteHeader +
 * SiteFooter.
 */

/** One entry in a site header/footer nav. External links render as real
 * `<a>` (target=_blank) with a small arrow affordance. */
interface SiteNavItem {
  label: string;
  to: string;
  external?: boolean;
  /** Hide on small screens (header nav only — it is already crowded). */
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
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
      <Logo link />
      <nav className="flex items-center gap-4 text-sm">
        <Button asChild variant="ghost" size="sm" className="ml-2">
          <Link to="/login">Sign in</Link>
        </Button>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-gray-100 dark:border-gray-700">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Logo icon /> · © {new Date().getFullYear()} · Built by{" "}
          <a href="https://labnotes.org">Assaf Arkin</a>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          {FOOTER_NAV.map((item) => (
            <SiteNavLink key={item.label} item={item} />
          ))}
        </nav>
      </div>
    </footer>
  );
}
