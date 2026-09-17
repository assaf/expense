import { JsonLd } from "~/components/JsonLd";
import { InlineMarkdown } from "~/components/Markdown";
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

export const headers = () => marketingPageHeaders("/alternatives.md");

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
      // Wider than the default page: the comparison tables are the argument
      // here, and six columns of prose do not fit the marketing width.
      className="max-w-6xl"
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
          <InlineMarkdown text={loaderData.pricingNote} />
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.inboxHeading}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          {loaderData.inboxNote}
        </p>
        <div className="mt-6 overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full min-w-250 border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                {loaderData.inboxTableHeadings.map((heading) => (
                  <th
                    key={heading}
                    className="px-4 py-3 font-semibold text-ink"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loaderData.inboxApps.map((app) => (
                <tr
                  key={app.app}
                  className="border-b border-gray-100 dark:border-gray-800 last:border-0"
                >
                  <th
                    scope="row"
                    className="px-4 py-3 align-top font-medium text-ink"
                  >
                    {app.site === SITE_URL ? (
                      app.app
                    ) : (
                      <a
                        href={app.site}
                        className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
                      >
                        {app.app}
                      </a>
                    )}
                  </th>
                  <td className="px-4 py-3 align-top leading-relaxed text-gray-700 dark:text-gray-200">
                    {app.price}
                  </td>
                  <td className="px-4 py-3 align-top font-medium leading-relaxed text-ink">
                    {app.inbox}
                  </td>
                  <td className="px-4 py-3 align-top leading-relaxed text-gray-700 dark:text-gray-200">
                    {app.scheduleC}
                  </td>
                  <td className="px-4 py-3 align-top leading-relaxed text-gray-700 dark:text-gray-200">
                    {app.mileage}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.exampleHeading}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          {loaderData.exampleIntro}
        </p>
        <ol className="mt-6 flex flex-col gap-6">
          {loaderData.example.map((step, i) => (
            <li key={step.step} className="flex gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 dark:bg-gray-800 text-sm font-bold text-blue-600 dark:text-blue-400">
                {i + 1}
              </span>
              <div>
                <h3 className="font-semibold text-ink">{step.step}</h3>
                <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                  {step.what}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.mappingHeading}
        </h2>
        <ul className="mt-6 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-gray-700 dark:text-gray-200">
          {loaderData.mapping.map((row) => (
            <li key={row.email}>
              <span className="font-medium text-ink">{row.email}</span>{" "}
              {row.lands}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          <InlineMarkdown text={loaderData.mappingNote} />
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.limitsHeading}
        </h2>
        <ul className="mt-6 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-gray-700 dark:text-gray-200">
          {loaderData.limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.sourcesHeading}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          <InlineMarkdown text={loaderData.sourcesNote} />
        </p>
        <ul className="mt-6 flex flex-col gap-3 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          {loaderData.sources.map((source) => (
            <li key={source.app}>
              <span className="font-medium text-ink">{source.app}</span>,
              checked {source.checked}:{" "}
              {source.urls.map((url) => (
                <a
                  key={url}
                  href={url}
                  className="mr-2 break-all underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
                >
                  {url}
                </a>
              ))}
            </li>
          ))}
        </ul>
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
