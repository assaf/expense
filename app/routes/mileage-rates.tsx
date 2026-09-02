import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import {
  currentMileageSummary,
  MILEAGE_PAGE_SUMMARY,
  mileageRateRows,
  marketingPageHeaders,
  pageMeta,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/mileage-rates";

const MILEAGE_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: "IRS standard mileage rates by year",
  url: `${SITE_URL}/mileage-rates`,
  description: MILEAGE_PAGE_SUMMARY,
};

export function meta(): Route.MetaDescriptors {
  const latest = mileageRateRows()[0]!;
  return pageMeta(
    `IRS standard mileage rates by year (2011 to ${latest.end.slice(0, 4)})`,
    `${currentMileageSummary()} The full table by period, with mid-year changes.`,
    "/mileage-rates",
  );
}

export const headers = marketingPageHeaders;

export default function MileageRatesPage() {
  const rows = mileageRateRows();
  return (
    <MarketingPage
      eyebrow="Reference"
      title="IRS standard mileage rates by year"
      summary={MILEAGE_PAGE_SUMMARY}
      schema={
        <script type="application/ld+json">
          {JSON.stringify(MILEAGE_SCHEMA)}
        </script>
      }
    >
      <section className="mt-10">
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full min-w-120 border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                <th className="px-4 py-3 font-semibold text-ink">Period</th>
                <th className="px-4 py-3 font-semibold text-ink">Business</th>
                <th className="px-4 py-3 font-semibold text-ink">Medical</th>
                <th className="px-4 py-3 font-semibold text-ink">Moving</th>
                <th className="px-4 py-3 font-semibold text-ink">Charity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.start}
                  className="border-b border-gray-100 dark:border-gray-800 last:border-0"
                >
                  <th
                    scope="row"
                    className="px-4 py-3 align-top font-medium text-ink"
                  >
                    {row.period}
                  </th>
                  <td className="px-4 py-3 align-top text-gray-700 dark:text-gray-200">
                    ${row.business}
                  </td>
                  <td className="px-4 py-3 align-top text-gray-700 dark:text-gray-200">
                    ${row.medical}
                  </td>
                  <td className="px-4 py-3 align-top text-gray-700 dark:text-gray-200">
                    ${row.moving}
                  </td>
                  <td className="px-4 py-3 align-top text-gray-700 dark:text-gray-200">
                    ${row.charity}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          Source:{" "}
          <a
            href="https://www.irs.gov/tax-professionals/standard-mileage-rates"
            className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
          >
            IRS standard mileage rates
          </a>
          . The moving rate applies only to Armed Forces and Intelligence
          Community members moving under orders, and the charitable rate is
          fixed by statute.
        </p>
      </section>

      <MarketingCta
        heading="Expense applies these rates for you."
        body="Log a drive on the map and the deduction follows the IRS rate for its date and type. No tables to check."
        className="mt-12 py-10"
        buttonRow="mt-6"
      />
    </MarketingPage>
  );
}
