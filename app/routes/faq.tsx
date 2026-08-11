import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import {
  APP_NAME,
  APP_SUMMARY,
  FAQS,
  marketingPageHeaders,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/faq";

/** FAQPage structured data — the primary signal for FAQ-style AI answers. */
const FAQ_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQS.map((f) => ({
    "@type": "Question",
    name: f.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: f.answer,
    },
  })),
};

export function meta(): Route.MetaDescriptors {
  return [
    {
      title: `${APP_NAME} FAQ: expense tracking for tax season with receipt OCR, AI categories, and mileage`,
    },
    {
      name: "description",
      content:
        "Plain answers to common questions about Expense: what it's for, how receipt OCR and AI categories work, whether it tracks mileage, and how it helps at tax time.",
    },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}/faq` },
  ];
}

export const headers = marketingPageHeaders;

export default function FaqPage() {
  return (
    <MarketingPage
      eyebrow="FAQ"
      title="Frequently Asked Questions"
      summary={APP_SUMMARY}
      className="max-w-3xl"
      schema={
        <script type="application/ld+json">{JSON.stringify(FAQ_SCHEMA)}</script>
      }
    >
      <div className="mt-10 flex flex-col gap-4">
        {FAQS.map((f) => (
          <article
            key={f.question}
            className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5"
          >
            <h2 className="font-semibold text-ink">{f.question}</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
              {f.answer}
            </p>
          </article>
        ))}
      </div>

      <MarketingCta
        heading="Still have questions? Just try it."
        body="Accounts are free and start empty. Add your first receipt in under a minute."
        className="mt-12 py-10"
        buttonRow="mt-6"
      />
    </MarketingPage>
  );
}
