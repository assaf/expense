import { DocumentSections } from "~/components/Markdown";
import { MarketingPage } from "~/components/MarketingPage";
import { PRIVACY } from "~/lib/content.server";
import { marketingPageHeaders, pageMeta } from "~/lib/seo-content";
import type { Route } from "./+types/privacy";

export function loader() {
  return PRIVACY;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  return pageMeta(loaderData.metaTitle, loaderData.description, "/privacy");
}

export const headers = () => marketingPageHeaders("/privacy.md");

export default function PrivacyPage({ loaderData }: Route.ComponentProps) {
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
