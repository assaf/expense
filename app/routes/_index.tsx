import { data } from "react-router";
import LandingPage from "~/components/LandingPage";
import { marketingPageHeaders, OG_IMAGE, SITE_URL } from "~/lib/seo-content";
import { ABOUT } from "~/lib/content.server";
import { countAccounts } from "~/lib/db/accounts";
import type { Route } from "./+types/_index";

/**
 * `/` is the marketing landing page for everyone, signed-in visitors
 * included: the expense list lives at /expenses. Keeping one anonymous
 * document here is what lets the CDN serve it (the root loader omits
 * session data on public paths), so crawlers and uptime monitors stop
 * invoking a function for every hit.
 */
export async function loader() {
  // The landing page shows how many of the 100 free spots are claimed.
  const signupCount = await countAccounts();
  return data({ signupCount, benefits: ABOUT.benefits });
}

export const headers = () => marketingPageHeaders();

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Expense: every receipt, ready for tax season" },
    {
      name: "description",
      content:
        "Snap a photo, paste a screenshot, or forward a receipt email. Expense reads the merchant and amount and files each one into IRS Schedule C categories and reports, ready to export for tax season.",
    },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}/` },
    { property: "og:url", content: `${SITE_URL}/` },
    {
      property: "og:title",
      content: "Expense: every receipt, ready for tax season",
    },
    {
      property: "og:description",
      content:
        "Snap a photo or forward a receipt and the merchant, amount, and category are filled in automatically. Organized into Schedule C categories and reports, ready to hand your accountant at tax time.",
    },
    { property: "og:image", content: OG_IMAGE },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    {
      property: "og:image:alt",
      content:
        "The Expense home page: report totals, receipts with thumbnails, and a mileage entry",
    },
    {
      name: "twitter:title",
      content: "Expense: every receipt, ready for tax season",
    },
    {
      name: "twitter:description",
      content:
        "Snap a photo or forward a receipt and the merchant, amount, and category are filled in automatically. Organized into Schedule C categories and reports, ready to hand your accountant at tax time.",
    },
    { name: "twitter:image", content: OG_IMAGE },
    {
      name: "twitter:image:alt",
      content:
        "The Expense home page: report totals, receipts with thumbnails, and a mileage entry",
    },
  ];
}

export default function IndexPage({ loaderData }: Route.ComponentProps) {
  return (
    <LandingPage
      signupCount={loaderData.signupCount}
      benefits={loaderData.benefits}
    />
  );
}
