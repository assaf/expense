import { Link } from "react-router";
import { SitePage } from "~/components/SitePage";
import { Button } from "~/components/ui/Button";
import {
  APP_NAME,
  COMPARISON_FAQ,
  COMPARISON_ROWS,
  COMPARISON_SUMMARY,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/alternatives";

const COMPARISON_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: `${APP_NAME} vs Expensify — a free alternative`,
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
  return [
    {
      title: `${APP_NAME} vs Expensify — a free alternative for expense tracking`,
    },
    {
      name: "description",
      content:
        "Expense is a free alternative to Expensify for personal and small-team expense tracking: OCR receipt capture, AI categories, Schedule C–based categories, mileage at the IRS rate, and tax-time exports.",
    },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}/alternatives` },
  ];
}

export default function AlternativesPage() {
  return (
    <SitePage>
      <script type="application/ld+json">
        {JSON.stringify(COMPARISON_SCHEMA)}
      </script>
      <script type="application/ld+json">
        {JSON.stringify(VERDICT_SCHEMA)}
      </script>
      <main className="mx-auto max-w-4xl px-4 pb-16 pt-12 sm:px-6">
        <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-blue-600">
          Compare
        </p>
        <h1 className="text-4xl font-black tracking-tight text-ink sm:text-5xl">
          {APP_NAME} vs Expensify — a free alternative.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-gray-600">
          {COMPARISON_SUMMARY}
        </p>

        <section className="mt-10 overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full min-w-[560px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="w-32 px-4 py-3 font-semibold text-gray-500">
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
                  className="border-b border-gray-100 last:border-0"
                >
                  <th
                    scope="row"
                    className="px-4 py-3 align-top font-medium text-gray-500"
                  >
                    {row.aspect}
                  </th>
                  <td className="px-4 py-3 align-top leading-relaxed text-gray-700">
                    {row.expense}
                  </td>
                  <td className="px-4 py-3 align-top leading-relaxed text-gray-700">
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
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">
              <h3 className="font-semibold text-blue-900">
                Choose {APP_NAME} if…
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-blue-900/80">
                You track your own expenses — for yourself, a side hustle, or a
                small team — and want them ready for tax season without typing
                in receipts.
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
              <h3 className="font-semibold text-gray-700">
                Choose Expensify if…
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-600">
                You run a company that needs employee expense policies, approval
                workflows, reimbursements, and accounting-software integrations
                — and a budget for per-user subscriptions.
              </p>
            </div>
          </div>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-bold tracking-tight text-ink">
            {VERDICT_QUESTION.question}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-gray-600">
            {VERDICT_QUESTION.answer}
          </p>
        </section>

        <section className="mt-12 rounded-2xl bg-ink px-6 py-10 text-center sm:px-12">
          <h2 className="text-2xl font-bold tracking-tight text-white">
            Try {APP_NAME} free.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-gray-300">
            No subscription, no 25-scan monthly cap, no ads.
          </p>
          <div className="mt-6">
            <Button
              asChild
              size="lg"
              className="w-full bg-white text-ink hover:bg-gray-100 sm:w-auto"
            >
              <Link to="/login?mode=create">Create your account</Link>
            </Button>
          </div>
        </section>
      </main>
    </SitePage>
  );
}
