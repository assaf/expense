import { CheckCircle2 } from "lucide-react";
import { JsonLd } from "~/components/JsonLd";
import { InlineMarkdown } from "~/components/Markdown";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import { Card } from "~/components/ui/Card";
import { PRODUCT_FACTS, scheduleCRows } from "~/lib/content.server";
import { countAccounts } from "~/lib/db/accounts";
import {
  EARLY_ACCESS_SPOTS,
  marketingPageHeaders,
  pageMeta,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/product-facts";

export async function loader() {
  // The one number on this page that moves: how much of the early-access cap
  // is gone. The landing page counts the same accounts for anonymous
  // visitors.
  const spotsClaimed = await countAccounts();
  return { ...PRODUCT_FACTS, spotsClaimed, rows: scheduleCRows() };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  return pageMeta(
    loaderData.metaTitle,
    loaderData.description,
    "/product-facts",
  );
}

export const headers = () => marketingPageHeaders("/product-facts.md");

export default function ProductFactsPage({ loaderData }: Route.ComponentProps) {
  const factsSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Expense product facts",
    url: `${SITE_URL}/product-facts`,
    description: loaderData.summary,
    mainEntity: {
      "@type": "SoftwareApplication",
      name: "Expense",
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    },
  };

  return (
    <MarketingPage
      eyebrow={loaderData.eyebrow}
      title={loaderData.title}
      summary={loaderData.summary}
      schema={<JsonLd data={factsSchema} />}
    >
      <section className="mt-10">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.factsHeading}
        </h2>
        <div className="mt-6 overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full min-w-150 border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                <th className="px-4 py-3 font-semibold text-ink">
                  {loaderData.tableHeadings[0]}
                </th>
                <th className="px-4 py-3 font-semibold text-ink">
                  {loaderData.tableHeadings[1]}
                </th>
              </tr>
            </thead>
            <tbody>
              {loaderData.facts.map((fact) => (
                <tr
                  key={fact.label}
                  className="border-b border-gray-100 dark:border-gray-800 last:border-0"
                >
                  <th
                    scope="row"
                    className="px-4 py-3 align-top font-medium text-ink"
                  >
                    {fact.label}
                  </th>
                  <td className="px-4 py-3 align-top leading-relaxed text-gray-700 dark:text-gray-200">
                    <InlineMarkdown text={fact.value} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loaderData.spotsClaimed > 0 ? (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            {loaderData.spotsClaimed} of {EARLY_ACCESS_SPOTS} free spots
            claimed.
          </p>
        ) : null}
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.categoriesHeading}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          <InlineMarkdown text={loaderData.categoriesNote} />
        </p>
        <ul className="mt-6 grid gap-2 sm:grid-cols-2">
          {loaderData.rows.map((row) => (
            <li
              key={row.line}
              className="text-sm leading-relaxed text-gray-700 dark:text-gray-200"
            >
              <span className="font-medium text-ink">Line {row.line}</span>{" "}
              {row.name}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.captureHeading}
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {loaderData.capture.map((method) => (
            <Card key={method.method} className="p-5">
              <h3 className="font-semibold text-ink">{method.method}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                {method.what}
              </p>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.pricingHeading}
        </h2>
        <ul className="mt-6 flex flex-col gap-3">
          {loaderData.pricing.map((line) => (
            <li key={line} className="flex items-start gap-2">
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
              />
              <span className="text-sm leading-relaxed text-gray-700 dark:text-gray-200">
                {line}
              </span>
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
