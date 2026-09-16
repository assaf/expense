import { JsonLd } from "~/components/JsonLd";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import { ALTERNATIVES } from "~/lib/content.server";
import { marketingPageHeaders, pageMeta, SITE_URL } from "~/lib/seo-content";
import type { Route } from "./+types/alternatives";

export function loader() {
  return ALTERNATIVES;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  return pageMeta(
    loaderData.metaTitle,
    loaderData.description,
    "/alternatives",
  );
}

export const headers = marketingPageHeaders;

export default function AlternativesPage({ loaderData }: Route.ComponentProps) {
  const comparisonSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `How Expense compares to the other receipt apps`,
    url: `${SITE_URL}/alternatives`,
    description: loaderData.summary,
  };

  return (
    <MarketingPage
      eyebrow={loaderData.eyebrow}
      title={loaderData.title}
      summary={loaderData.summary}
      schema={<JsonLd data={comparisonSchema} />}
    >
      <section className="mt-10">
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full min-w-180 border-collapse text-left text-sm">
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
              </tr>
            </thead>
            <tbody>
              {loaderData.competitors.map((row) => (
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
          {loaderData.pricingNote}
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
