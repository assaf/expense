import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "~/components/SiteChrome";

/**
 * Chrome for public marketing/SEO pages: header with site nav, the page
 * content, and the standard footer. Shares the SiteHeader/SiteFooter used by
 * the LandingPage (see SiteChrome), so every public page looks like one site.
 */
export function SitePage({
  children,
  padBottom = false,
}: {
  children: ReactNode;
  /** Extra space under the footer so the landing page's fixed tips slider
   * never covers the footer links when scrolled to the bottom. */
  padBottom?: boolean;
}) {
  return (
    <div className="min-h-screen bg-canvas">
      <SiteHeader />
      {children}
      <SiteFooter />
      {padBottom ? <div aria-hidden="true" className="h-72 sm:h-56" /> : null}
    </div>
  );
}
