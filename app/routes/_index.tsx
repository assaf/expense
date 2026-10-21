import { data } from "react-router";
import LandingPage from "~/components/LandingPage";
import { marketingPageHeaders, OG_IMAGE, SITE_URL } from "~/lib/seo-content";
import { ABOUT, SITE } from "~/lib/content.server";
import type { Route } from "./+types/_index";

/**
 * `/` is the marketing landing page for everyone, signed-in visitors
 * included: the expense list lives at /expenses. Keeping one anonymous
 * document here is what lets the CDN serve it (the root loader omits
 * session data on public paths), so crawlers and uptime monitors stop
 * invoking a function for every hit.
 */
export async function loader() {
  return data({ benefits: ABOUT.benefits, headline: SITE.appHeadline });
}

export const headers = () => marketingPageHeaders();

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  // The promise lives in app/data/site.yaml, and the page title reads it
  // from here, so the title cannot drift from the h1. The other pages drop
  // their meta when the loader data is missing; the front door keeps its
  // title and its card either way.
  const headline = loaderData?.headline;
  const title = headline ? `Expense: ${headline}` : "Expense";
  // The card's alt describes what the image shows, and deliberately does
  // not quote the headline: the card is a committed picture of that
  // sentence, so a live quote would contradict the image the day the copy
  // moves and the card has not been regenerated yet.
  const cardAlt =
    "The Expense app's name and headline beside a framed screenshot of the expense list, with receipts, categories and amounts.";
  return [
    { title },
    {
      name: "description",
      content:
        "Snap a photo, paste a screenshot, or forward a receipt email. Expense reads the merchant and amount and files each one into IRS Schedule C categories and reports, ready to export for tax season.",
    },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}/` },
    { property: "og:url", content: `${SITE_URL}/` },
    {
      property: "og:title",
      content: title,
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
      content: cardAlt,
    },
    {
      name: "twitter:title",
      content: title,
    },
    {
      name: "twitter:description",
      content:
        "Snap a photo or forward a receipt and the merchant, amount, and category are filled in automatically. Organized into Schedule C categories and reports, ready to hand your accountant at tax time.",
    },
    { name: "twitter:image", content: OG_IMAGE },
    {
      name: "twitter:image:alt",
      content: cardAlt,
    },
  ];
}

export default function IndexPage({ loaderData }: Route.ComponentProps) {
  return (
    <LandingPage
      benefits={loaderData.benefits}
      headline={loaderData.headline}
    />
  );
}
