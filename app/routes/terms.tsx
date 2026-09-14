import { MarketingPage } from "~/components/MarketingPage";
import {
  TERMS_SECTIONS,
  TERMS_SUMMARY,
  TERMS_UPDATED,
  marketingPageHeaders,
  pageMeta,
} from "~/lib/seo-content";
import type { Route } from "./+types/terms";

export function meta(): Route.MetaDescriptors {
  return pageMeta(
    "Terms of service",
    "The rules for using Expense: your account, your data, what is not allowed, and what the app does not promise.",
    "/terms",
  );
}

export const headers = marketingPageHeaders;

export default function TermsPage() {
  return (
    <MarketingPage
      eyebrow="Terms"
      title="The rules for using Expense"
      summary={TERMS_SUMMARY}
    >
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Last updated {TERMS_UPDATED}.
      </p>

      <div className="mt-6 flex flex-col gap-10">
        {TERMS_SECTIONS.map((section) => (
          <section key={section.title}>
            <h2 className="text-2xl font-bold tracking-tight text-ink">
              {section.title}
            </h2>
            {section.paragraphs.map((paragraph) => (
              <p
                key={paragraph}
                className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300"
              >
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </div>
    </MarketingPage>
  );
}
