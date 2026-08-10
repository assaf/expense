import { CheckCircle2 } from "lucide-react";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import {
  APP_NAME,
  APP_SUMMARY,
  AUTHOR_NAME,
  BENEFITS,
  BLOG_URL,
  KEY_FACTS,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/about";

const ABOUT_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "AboutPage",
  name: `About ${APP_NAME}`,
  url: `${SITE_URL}/about`,
  description: APP_SUMMARY,
  author: {
    "@type": "Person",
    name: AUTHOR_NAME,
    url: BLOG_URL,
  },
};

export function meta(): Route.MetaDescriptors {
  return [
    {
      title: `About ${APP_NAME}: a free expense tracker built for tax season`,
    },
    {
      name: "description",
      content:
        "Expense is a free expense tracker built for tax season: OCR reads receipts, AI suggests categories, mileage logs at the IRS rate, and PDF or ZIP export is ready when you are.",
    },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}/about` },
  ];
}

export function headers() {
  return {
    "Cache-Control":
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400, must-revalidate",
  };
}

export default function AboutPage() {
  return (
    <MarketingPage
      eyebrow="About"
      title="Expense – The Free Receipt Tracker for Tax Season."

      summary={APP_SUMMARY}
      schema={
        <script type="application/ld+json">
          {JSON.stringify(ABOUT_SCHEMA)}
        </script>
      }
    >
      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          What do you get
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {BENEFITS.map((b) => (
            <div
              key={b.title}
              className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5"
            >
              <h3 className="font-semibold text-ink">{b.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                {b.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          Key facts
        </h2>
        <ul className="mt-6 flex flex-col gap-3">
          {KEY_FACTS.map((fact) => (
            <li key={fact} className="flex items-start gap-2">
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
              />
              <span className="text-sm leading-relaxed text-gray-700 dark:text-gray-200">
                {fact}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <MarketingCta
        heading="Start collecting this year's expenses."
        body="Accounts are free and start empty. Add your first receipt in under a minute."
        secondaryLabel="Read the FAQ"
        secondaryHref="/faq"
      />
    </MarketingPage>
  );
}
