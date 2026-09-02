import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import {
  SCHEDULE_C_PAGE_SUMMARY,
  SCHEDULE_C_ROWS,
  marketingPageHeaders,
  pageMeta,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/schedule-c-categories";

const SCHEDULE_C_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: "Schedule C expense categories",
  url: `${SITE_URL}/schedule-c-categories`,
  description: SCHEDULE_C_PAGE_SUMMARY,
};

export function meta(): Route.MetaDescriptors {
  return pageMeta(
    "Schedule C expense categories: Part II, lines 8 to 27a",
    `The 23 expense lines on IRS Schedule C, Part II, in the form's order, with a plain-language note for each. ${SCHEDULE_C_ROWS.length} categories, the same list Expense seeds every new account with.`,
    "/schedule-c-categories",
  );
}

export const headers = marketingPageHeaders;

export default function ScheduleCCategoriesPage() {
  return (
    <MarketingPage
      eyebrow="Reference"
      title="Schedule C expense categories"
      summary={SCHEDULE_C_PAGE_SUMMARY}
      schema={
        <script type="application/ld+json">
          {JSON.stringify(SCHEDULE_C_SCHEMA)}
        </script>
      }
    >
      <section className="mt-10">
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full min-w-150 border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                <th className="px-4 py-3 font-semibold text-ink">Line</th>
                <th className="px-4 py-3 font-semibold text-ink">Category</th>
                <th className="px-4 py-3 font-semibold text-ink">
                  What goes there
                </th>
              </tr>
            </thead>
            <tbody>
              {SCHEDULE_C_ROWS.map((row) => (
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
          Source:{" "}
          <a
            href="https://www.irs.gov/forms-pubs/about-schedule-c-form-1040"
            className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
          >
            About Schedule C (Form 1040)
          </a>
          . Car and truck expenses can also use the standard mileage rate; see
          the IRS mileage rates page for the full table.
        </p>
      </section>

      <MarketingCta
        heading="Your categories, ready for the form."
        body="Every new Expense account starts with these 23 categories in place, so receipts land where the return expects them."
        className="mt-12 py-10"
        buttonRow="mt-6"
      />
    </MarketingPage>
  );
}
