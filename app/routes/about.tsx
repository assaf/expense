import { CheckCircle2 } from "lucide-react";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import { Card } from "~/components/ui/Card";
import {
  APP_NAME,
  APP_SUMMARY,
  AUTHOR_NAME,
  BENEFITS,
  BLOG_URL,
  KEY_FACTS,
  marketingPageHeaders,
  pageMeta,
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
  return pageMeta(
    `About ${APP_NAME}: a free expense tracker built for tax season`,
    "Expense is a free expense tracker built for tax season: OCR reads receipts, AI suggests categories, mileage logs at the IRS rate, and PDF or ZIP export is ready when you are.",
    "/about",
  );
}

export const headers = marketingPageHeaders;

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
            <Card key={b.title} className="p-5">
              <h3 className="font-semibold text-ink">{b.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                {b.body}
              </p>
            </Card>
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
