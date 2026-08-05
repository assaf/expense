import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "~/components/SiteChrome";

/**
 * Chrome for public marketing/SEO pages: header with site nav, the page
 * content, and the standard footer. Shares the SiteHeader/SiteFooter used by
 * the LandingPage (see SiteChrome), so every public page looks like one site.
 */
export function SitePage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white">
      <SiteHeader />
      {children}
      <SiteFooter />
    </div>
  );
}
