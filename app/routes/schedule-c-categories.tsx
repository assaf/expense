import { JsonLd } from "~/components/JsonLd";
import { InlineMarkdown } from "~/components/Markdown";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import { SCHEDULE_C_PAGE, scheduleCRows } from "~/lib/content.server";
import { marketingPageHeaders, pageMeta, SITE_URL } from "~/lib/seo-content";
import type { Route } from "./+types/schedule-c-categories";

export function loader() {
  return { ...SCHEDULE_C_PAGE, rows: scheduleCRows() };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  return pageMeta(
    loaderData.metaTitle,
    loaderData.description,
    "/schedule-c-categories",
  );
}

export const headers = () => marketingPageHeaders("/schedule-c-categories.md");

export default function ScheduleCCategoriesPage({
  loaderData,
}: Route.ComponentProps) {
  const scheduleCSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Schedule C expense categories",
    url: `${SITE_URL}/schedule-c-categories`,
    description: loaderData.summary,
  };

  return (
    <MarketingPage
      eyebrow={loaderData.eyebrow}
      title={loaderData.title}
      summary={loaderData.summary}
      schema={<JsonLd data={scheduleCSchema} />}
    >
      <section className="mt-10">
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full min-w-150 border-collapse text-left text-sm">
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
              </tr>
            </thead>
            <tbody>
              {loaderData.rows.map((row) => (
                <tr
                  key={row.line}
                  className="border-b border-gray-100 dark:border-gray-800 last:border-0"
                >
                  <th
                    scope="row"
                    className="px-4 py-3 align-top font-medium text-ink"
                  >
                    {row.line}
                  </th>
                  <td className="px-4 py-3 align-top font-medium text-gray-700 dark:text-gray-200">
                    {row.name}
                  </td>
                  <td className="px-4 py-3 align-top leading-relaxed text-gray-700 dark:text-gray-200">
                    {row.note}
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
