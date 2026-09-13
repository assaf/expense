import { MarketingPage } from "~/components/MarketingPage";
import {
  PRIVACY_SECTIONS,
  PRIVACY_SUMMARY,
  PRIVACY_UPDATED,
  marketingPageHeaders,
  pageMeta,
} from "~/lib/seo-content";
import type { Route } from "./+types/privacy";

export function meta(): Route.MetaDescriptors {
  return pageMeta(
    "Privacy policy",
    "What Expense stores, where it lives, which providers see what, and what it never does.",
    "/privacy",
  );
}

export const headers = marketingPageHeaders;

export default function PrivacyPage() {
  return (
    <MarketingPage
      eyebrow="Privacy"
      title="What Expense does with your data"
      summary={PRIVACY_SUMMARY}
    >
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Last updated {PRIVACY_UPDATED}.
      </p>

      <div className="mt-6 flex flex-col gap-10">
        {PRIVACY_SECTIONS.map((section) => (
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
