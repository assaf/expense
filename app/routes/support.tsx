import { DocumentSections } from "~/components/Markdown";
import { MarketingPage } from "~/components/MarketingPage";
import { SUPPORT } from "~/lib/content.server";
import { marketingPageHeaders, pageMeta } from "~/lib/seo-content";
import type { Route } from "./+types/support";

export function loader() {
  return SUPPORT;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  return pageMeta(loaderData.metaTitle, loaderData.description, "/support");
}

export const headers = () => marketingPageHeaders("/support.md");

export default function SupportPage({ loaderData }: Route.ComponentProps) {
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
