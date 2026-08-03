import { ReceiptText } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { BLOG_URL, GITHUB_URL } from "~/lib/seo-content";

/**
 * Chrome for public marketing/SEO pages: header with site nav, the page
 * content, and the standard footer. Mirrors the LandingPage header/footer
 * so every public page looks like one site.
 */
export function SitePage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Link
          to="/"
          className="flex items-center gap-2 rounded-lg font-semibold"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink">
            <ReceiptText className="h-4 w-4 text-white" />
          </span>
          Expense
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <NavLink to="/about">About</NavLink>
          <NavLink to="/faq">FAQ</NavLink>
          <NavLink to="/alternatives">Compare</NavLink>
          <NavLink to={GITHUB_URL} external className="hidden sm:inline-flex">
            GitHub
          </NavLink>
          <Button asChild variant="ghost" size="sm" className="ml-2">
            <Link to="/login">Sign in</Link>
          </Button>
        </nav>
      </header>

      {children}

      <footer className="border-t border-gray-100">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-ink">
              <ReceiptText className="h-3 w-3 text-white" />
            </span>
            Expense · © {new Date().getFullYear()} · Built by Assaf Arkin
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <NavLink to="/about">About</NavLink>
            <NavLink to="/faq">FAQ</NavLink>
            <NavLink to="/alternatives">Compare</NavLink>
            <NavLink to={GITHUB_URL} external>
              GitHub
            </NavLink>
            <NavLink to={BLOG_URL} external>
              Blog
            </NavLink>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function NavLink({
  to,
  children,
  external = false,
  className = "",
}: {
  to: string;
  children: ReactNode;
  external?: boolean;
  className?: string;
}) {
  const base = "rounded-md text-gray-500 transition-colors hover:text-ink";
  if (external) {
    return (
      <a
        href={to}
        target="_blank"
        rel="noreferrer"
        className={`${base} ${className}`}
      >
        {children}
      </a>
    );
  }
  return (
    <Link to={to} className={`${base} ${className}`}>
      {children}
    </Link>
  );
}
