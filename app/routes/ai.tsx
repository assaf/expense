import { Bot, Link2 } from "lucide-react";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import { InlineMarkdown } from "~/components/Markdown";
import {
  CapabilitiesSection,
  PromptsSection,
  SecuritySection,
} from "~/components/mcp-sections";
import { AI, MCP } from "~/lib/content.server";
import { marketingPageHeaders, pageMeta, SITE_URL } from "~/lib/seo-content";
import type { Route } from "./+types/ai";
import { JsonLd } from "~/components/JsonLd";

export function loader() {
  return { ...AI, mcp: MCP };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  if (!loaderData) return [];
  return pageMeta(loaderData.metaTitle, loaderData.description, "/ai");
}

export const headers = () => marketingPageHeaders("/ai.md");

export default function AiPage({ loaderData }: Route.ComponentProps) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `Connect your AI assistant: Expense`,
    url: `${SITE_URL}/ai`,
    description: loaderData.summary,
    author: {
      "@type": "Person",
      name: "Assaf Arkin",
      url: "https://labnotes.org",
    },
  };
  return (
    <MarketingPage
      eyebrow={loaderData.eyebrow}
      title={loaderData.title}
      summary={loaderData.summary}
      schema={<JsonLd data={schema} />}
    >
      <CapabilitiesSection
        heading={loaderData.mcp.capabilitiesHeading}
        capabilities={loaderData.mcp.capabilities}
      />

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.stepsHeading}
        </h2>
        <ol className="mt-6 flex flex-col gap-6">
          {loaderData.steps.map((step, i) => (
            <li key={step.title} className="flex gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 dark:bg-gray-800 text-sm font-bold text-blue-600 dark:text-blue-400">
                {i + 1}
              </span>
              <div>
                <h3 className="font-semibold text-ink">{step.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div
          className="mt-6 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700
        bg-gray-50 dark:bg-gray-900"
        >
          <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2.5 text-xs font-medium text-gray-500 dark:text-gray-400">
            <Link2 aria-hidden="true" className="h-3.5 w-3.5" />{" "}
            {loaderData.mcpConfigHeading}
          </div>
          <pre className="overflow-x-auto px-4 py-3 text-sm text-gray-700 dark:text-gray-200">
            {loaderData.mcpConfigJson}
          </pre>
        </div>
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          <InlineMarkdown text={loaderData.connectNote} />
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.webmcpHeading}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          <InlineMarkdown text={loaderData.webmcpBody} />
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {loaderData.insightsHeading}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          {loaderData.insightsSummary}
        </p>
      </section>

      <PromptsSection
        heading={loaderData.mcp.promptsHeading}
        prompts={loaderData.mcp.prompts}
      />

      <SecuritySection
        heading={loaderData.mcp.securityHeading}
        security={loaderData.mcp.security}
      />

      <MarketingCta
        heading={loaderData.cta.heading}
        body={loaderData.cta.body}
        icon={<Bot aria-hidden="true" className="h-6 w-6 text-white" />}
        secondaryLabel={loaderData.cta.secondaryLabel}
        secondaryHref="/faq"
      />
    </MarketingPage>
  );
}
