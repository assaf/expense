import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import {
  APP_NAME,
  COMPARISON_FAQ,
  COMPARISON_ROWS,
  COMPARISON_SUMMARY,
  marketingPageHeaders,
  pageMeta,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/alternatives";

const COMPARISON_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: `${APP_NAME} vs Expensify: a free alternative`,
  url: `${SITE_URL}/alternatives`,
  description: COMPARISON_SUMMARY,
};

const VERDICT_QUESTION = COMPARISON_FAQ;

const VERDICT_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: VERDICT_QUESTION.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: VERDICT_QUESTION.answer,
      },
    },
  ],
};

export function meta(): Route.MetaDescriptors {
  return pageMeta(
    `${APP_NAME} vs Expensify: a free alternative for expense tracking`,
    "Expense is a free alternative to Expensify for personal and small-team expense tracking: OCR receipt capture, AI categories, Schedule C-based categories, mileage at the IRS rate, and tax-time exports.",
    "/alternatives",
  );
}

export const headers = marketingPageHeaders;

export default function AlternativesPage() {
  return (
    <MarketingPage
      eyebrow="Compare"
      title={`${APP_NAME} vs Expensify: a free alternative.`}
      summary={COMPARISON_SUMMARY}
      schema={
        <>
          <script type="application/ld+json">
            {JSON.stringify(COMPARISON_SCHEMA)}
          </script>
          <script type="application/ld+json">
            {JSON.stringify(VERDICT_SCHEMA)}
          </script>
        </>
      }
    >
      <section className="mt-10 overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
        <table className="w-full min-w-140 border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <th className="w-32 px-4 py-3 font-semibold text-gray-500 dark:text-gray-400">
                Aspect
              </th>
              <th className="px-4 py-3 font-semibold text-ink">{APP_NAME}</th>
              <th className="px-4 py-3 font-semibold text-ink">Expensify</th>
            </tr>
          </thead>
          <tbody>
            {COMPARISON_ROWS.map((row) => (
              <tr
                key={row.aspect}
                className="border-b border-gray-100 dark:border-gray-800 last:border-0"
              >
                <th
                  scope="row"
                  className="px-4 py-3 align-top font-medium text-gray-500 dark:text-gray-400"
                >
                  {row.aspect}
                </th>
                <td className="px-4 py-3 align-top leading-relaxed text-gray-700 dark:text-gray-200">
                  {row.expense}
                </td>
                <td className="px-4 py-3 align-top leading-relaxed text-gray-700 dark:text-gray-200">
                  {row.expensify}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-12">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          Which one should you choose?
        </h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-blue-200 dark:border-gray-700 bg-blue-50 dark:bg-gray-800 p-5">
            <h3 className="font-semibold text-blue-900 dark:text-blue-300">
              Choose {APP_NAME} if…
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-blue-900/80 dark:text-blue-300/80">
              You track your own expenses for yourself, your side projects, or
              small team, and you need these expenses prepared for tax season
              without any typing of receipts.
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-5">
            <h3 className="font-semibold text-gray-700 dark:text-gray-200">
              Choose Expensify if…
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
              You manage a company which requires employee expense policies,
              workflows, reimbursement, and integration with accounting
              software, and you have budget for per-user subscriptions.
            </p>
          </div>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {VERDICT_QUESTION.question}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          {VERDICT_QUESTION.answer}
        </p>
      </section>

      <MarketingCta
        heading={`Try ${APP_NAME} free.`}
        body="No subscription, no 25-scan monthly cap, no ads."
        className="mt-12 py-10"
        buttonRow="mt-6"
      />
    </MarketingPage>
  );
}
