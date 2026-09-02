import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import {
  APP_NAME,
  COMPETITOR_PRICING_NOTE,
  COMPETITOR_ROWS,
  COMPARISON_SUMMARY,
  marketingPageHeaders,
  pageMeta,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/alternatives";

const COMPARISON_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: `How ${APP_NAME} compares to the other receipt apps`,
  url: `${SITE_URL}/alternatives`,
  description: COMPARISON_SUMMARY,
};

export function meta(): Route.MetaDescriptors {
  return pageMeta(
    `Expense alternatives: how it compares to Expensify, Zoho Expense, SparkReceipt, Shoeboxed, and Wave`,
    `Where ${APP_NAME} fits among Expensify, Zoho Expense, SparkReceipt, Shoeboxed, and Wave: pricing, tax-filing focus, and who each app is best for.`,
    "/alternatives",
  );
}

export const headers = marketingPageHeaders;

export default function AlternativesPage() {
  return (
    <MarketingPage
      eyebrow="Compare"
      title={`How ${APP_NAME} compares to the other receipt apps.`}
      summary={COMPARISON_SUMMARY}
      schema={
        <script type="application/ld+json">
          {JSON.stringify(COMPARISON_SCHEMA)}
        </script>
      }
    >
      <section className="mt-10">
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full min-w-180 border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                <th className="px-4 py-3 font-semibold text-ink">App</th>
                <th className="px-4 py-3 font-semibold text-ink">Best for</th>
                <th className="px-4 py-3 font-semibold text-ink">Pricing</th>
                <th className="px-4 py-3 font-semibold text-ink">
                  Tax-filing focus
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPETITOR_ROWS.map((row) => (
                <tr
                  key={row.app}
                  className="border-b border-gray-100 dark:border-gray-800 last:border-0"
                >
                  <th
                    scope="row"
                    className="px-4 py-3 align-top font-medium text-ink"
                  >
                    {row.site === SITE_URL ? (
                      row.app
                    ) : (
                      <a
                        href={row.site}
                        className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
                      >
                        {row.app}
                      </a>
                    )}
                  </th>
                  <td className="px-4 py-3 align-top leading-relaxed text-gray-700 dark:text-gray-200">
                    {row.bestFor}
                  </td>
                  <td className="px-4 py-3 align-top leading-relaxed text-gray-700 dark:text-gray-200">
                    {row.pricing}
                  </td>
                  <td className="px-4 py-3 align-top leading-relaxed text-gray-700 dark:text-gray-200">
                    {row.taxFiling}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          {COMPETITOR_PRICING_NOTE}
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
