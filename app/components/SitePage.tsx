import type { ReactNode } from "react";
import {
  SiteFooter,
  SiteHeader,
  type SiteNavItem,
} from "~/components/SiteChrome";
import { BLOG_URL, GITHUB_URL } from "~/lib/seo-content";

const HEADER_NAV: SiteNavItem[] = [
  { label: "About", to: "/about" },
  { label: "AI", to: "/ai" },
  { label: "FAQ", to: "/faq" },
  { label: "Compare", to: "/alternatives" },
  { label: "GitHub", to: GITHUB_URL, external: true, hideOnMobile: true },
];

const FOOTER_NAV: SiteNavItem[] = [
  { label: "About", to: "/about" },
  { label: "AI", to: "/ai" },
  { label: "FAQ", to: "/faq" },
  { label: "Compare", to: "/alternatives" },
  { label: "GitHub", to: GITHUB_URL, external: true },
  { label: "Blog", to: BLOG_URL, external: true },
];

/**
 * Chrome for public marketing/SEO pages: header with site nav, the page
 * content, and the standard footer. Shares the SiteHeader/SiteFooter used by
 * the LandingPage (see SiteChrome), so every public page looks like one site.
 */
export function SitePage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white">
      <SiteHeader nav={HEADER_NAV} />
      {children}
      <SiteFooter nav={FOOTER_NAV} />
    </div>
  );
}
