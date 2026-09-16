import { JsonLd } from "~/components/JsonLd";
import { InlineMarkdown } from "~/components/Markdown";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import { MILEAGE_PAGE } from "~/lib/content.server";
import {
  marketingPageHeaders,
  mileageRateRows,
  pageMeta,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/mileage-rates";

export function loader() {
  return { ...MILEAGE_PAGE, rows: mileageRateRows() };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  return pageMeta(
    loaderData.metaTitle,
    loaderData.description,
    "/mileage-rates",
  );
}

export const headers = marketingPageHeaders;

export default function MileageRatesPage({ loaderData }: Route.ComponentProps) {
  const mileageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "IRS standard mileage rates by year",
    url: `${SITE_URL}/mileage-rates`,
    description: loaderData.summary,
  };

  return (
    <MarketingPage
      eyebrow={loaderData.eyebrow}
      title={loaderData.title}
      summary={loaderData.summary}
      schema={<JsonLd data={mileageSchema} />}
    >
      <section className="mt-10">
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full min-w-120 border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                <th className="px-4 py-3 font-semibold text-ink">
                  {loaderData.tableHeadings[0]}
                </th>
                <th className="px-4 py-3 font-semibold text-ink">
                  {loaderData.tableHeadings[1]}
                </th>
                <th className="px-4 py-3 font-semibold text-ink">
                  {loaderData.tableHeadings[2]}
                </th>
                <th className="px-4 py-3 font-semibold text-ink">
                  {loaderData.tableHeadings[3]}
                </th>
                <th className="px-4 py-3 font-semibold text-ink">
                  {loaderData.tableHeadings[4]}
                </th>
              </tr>
            </thead>
            <tbody>
              {loaderData.rows.map((row) => (
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
          <InlineMarkdown text={loaderData.sourceNote} />
        </p>
      </section>

      <MarketingCta
        heading={loaderData.cta.heading}
        body={loaderData.cta.body}
        className="mt-12 py-10"
        buttonRow="mt-6"
      />
    </MarketingPage>
  );
}
