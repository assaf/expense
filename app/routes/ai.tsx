import { Bot, Link2 } from "lucide-react";
import { Link } from "react-router";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import {
  CapabilitiesSection,
  PromptsSection,
  SecuritySection,
} from "~/components/mcp-sections";
import {
  AI_STEPS,
  AI_SUMMARY,
  APP_NAME,
  AUTHOR_NAME,
  BLOG_URL,
  marketingPageHeaders,
  pageMeta,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/ai";

const AI_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: `Connect your AI assistant: ${APP_NAME}`,
  url: `${SITE_URL}/ai`,
  description: AI_SUMMARY,
  author: {
    "@type": "Person",
    name: AUTHOR_NAME,
    url: BLOG_URL,
  },
};

export function meta(): Route.MetaDescriptors {
  return pageMeta(
    `${APP_NAME}: connect your AI assistant`,
    "Connect Claude, OpenAI, or any MCP client over the Expense MCP endpoint, or let a browser agent use Expense's in-page WebMCP tools: capture receipts, log mileage, answer spending questions, and build reports. No API keys.",
    "/ai",
  );
}

export const headers = marketingPageHeaders;

export default function AiPage() {
  return (
    <MarketingPage
      eyebrow="AI assistants"
      title="Connect your AI helper to Expense."
      summary={AI_SUMMARY}
      schema={
        <script type="application/ld+json">{JSON.stringify(AI_SCHEMA)}</script>
      }
    >
      <CapabilitiesSection />

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          How to connect
        </h2>
        <ol className="mt-6 flex flex-col gap-6">
          {AI_STEPS.map((step, i) => (
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
            <Link2 aria-hidden="true" className="h-3.5 w-3.5" /> Claude:
            .mcp.json
          </div>
          <pre className="overflow-x-auto px-4 py-3 text-sm text-gray-700 dark:text-gray-200">
            {`{
  "mcpServers": {
    "expense": {
      "type": "http",
      "url": "https://expense.labnotes.org/mcp"
    }
  }
}`}
          </pre>
        </div>
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          No headers or keys. The client discovers the sign-in flow itself.
          Claude and OpenAI connect the same way. Per-client setup instructions
          for Claude, Cursor, VS Code, ChatGPT, and more:{" "}
          <Link
            to="/connect"
            className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
          >
            Connect with MCP
          </Link>
          .
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          In the browser (WebMCP)
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          In browsers with WebMCP support (Chrome's origin trial), Expense also
          registers read-only in-page tools for the browser's own agent while
          you're signed in: list expenses, summarize spending, and list reports.
          Same data as the MCP server, your signed-in session, no setup. It's
          read-only; write actions still go through the MCP endpoint.
        </p>
      </section>

      <PromptsSection heading="Try asking" />

      <SecuritySection />

      <MarketingCta
        heading="Your expenses, on speaking terms with your assistant."
        body="Accounts are free and start empty. Add your first receipt in under a minute, then connect your assistant whenever you're ready."
        icon={<Bot aria-hidden="true" className="h-6 w-6 text-white" />}
        secondaryLabel="Read the FAQ"
        secondaryHref="/faq"
      />
    </MarketingPage>
  );
}
