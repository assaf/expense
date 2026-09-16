import { DocumentSections } from "~/components/Markdown";
import { MarketingPage } from "~/components/MarketingPage";
import { TERMS } from "~/lib/content.server";
import { marketingPageHeaders, pageMeta } from "~/lib/seo-content";
import type { Route } from "./+types/terms";

export function loader() {
  return TERMS;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  return pageMeta(loaderData.metaTitle, loaderData.description, "/terms");
}

export const headers = marketingPageHeaders;

export default function TermsPage({ loaderData }: Route.ComponentProps) {
  return (
    <MarketingPage
      eyebrow={loaderData.eyebrow}
      title={loaderData.title}
      summary={loaderData.summary}
    >
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Last updated {loaderData.updated}.
      </p>

      <div className="mt-6 flex flex-col gap-10">
        <DocumentSections sections={loaderData.sections} />
      </div>
    </MarketingPage>
  );
}
