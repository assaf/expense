import { Bot, Link2, ShieldCheck, Sparkles } from "lucide-react";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import {
  AI_CAPABILITIES,
  AI_PROMPTS,
  AI_SECURITY,
  AI_STEPS,
  AI_SUMMARY,
  APP_NAME,
  AUTHOR_NAME,
  BLOG_URL,
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
  return [
    { title: `${APP_NAME}: connect your AI assistant` },
    {
      name: "description",
      content:
        "Connect Claude, OpenAI, or any MCP client to Expense by signing in: capture receipts, log mileage, answer spending questions, build reports, and reconcile statements. No API keys.",
    },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}/ai` },
  ];
}

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
      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          What your assistant can do
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {AI_CAPABILITIES.map((c) => (
            <div
              key={c.title}
              className="rounded-xl border border-gray-200 bg-white p-5"
            >
              <h3 className="font-semibold text-ink">{c.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-600">
                {c.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          How to connect
        </h2>
        <ol className="mt-6 flex flex-col gap-6">
          {AI_STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-sm font-bold text-blue-600">
                {i + 1}
              </span>
              <div>
                <h3 className="font-semibold text-ink">{step.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-gray-600">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div
          className="mt-6 overflow-hidden rounded-xl border border-gray-200
        bg-gray-50"
        >
          <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-2.5 text-xs font-medium text-gray-500">
            <Link2 className="h-3.5 w-3.5" /> Claude: .mcp.json
          </div>
          <pre className="overflow-x-auto px-4 py-3 text-sm text-gray-700">
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
        <p className="mt-3 text-sm text-gray-500">
          No headers or keys. The client discovers the sign-in flow itself.
          Claude and OpenAI connect the same way.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          Try asking
        </h2>
        <ul className="mt-6 flex flex-col gap-3">
          {AI_PROMPTS.map((prompt) => (
            <li
              key={prompt}
              className="flex items-start gap-2 rounded-xl border border-gray-200 bg-white p-4"
            >
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
              <span className="text-sm leading-relaxed text-gray-700">
                {prompt}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">Security</h2>
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-5">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
          <p className="text-sm leading-relaxed text-gray-600">{AI_SECURITY}</p>
        </div>
      </section>

      <MarketingCta
        heading="Your expenses, on speaking terms with your assistant."
        body="Accounts are free and start empty. Add your first receipt in under a minute, then connect your assistant whenever you're ready."
        icon={<Bot className="h-6 w-6 text-white" />}
        secondaryLabel="Read the FAQ"
        secondaryHref="/faq"
      />
    </MarketingPage>
  );
}
