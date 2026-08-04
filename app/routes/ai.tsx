import { Bot, Link2, ShieldCheck, Sparkles } from "lucide-react";
import { Link } from "react-router";
import { SitePage } from "~/components/SitePage";
import { Button } from "~/components/ui/Button";
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
  name: `Connect your AI assistant — ${APP_NAME}`,
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
    { title: `${APP_NAME} — connect your AI assistant` },
    {
      name: "description",
      content:
        "Connect Claude, Cursor, or any MCP client to Expense by signing in — capture receipts, log mileage, answer spending questions, build reports, and reconcile statements. No API keys.",
    },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}/ai` },
  ];
}

export default function AiPage() {
  return (
    <SitePage>
      <script type="application/ld+json">{JSON.stringify(AI_SCHEMA)}</script>
      <main className="mx-auto max-w-4xl px-4 pb-16 pt-12 sm:px-6">
        <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-blue-600">
          AI assistants
        </p>
        <h1 className="text-4xl font-black tracking-tight text-ink sm:text-5xl">
          Connect your AI assistant.
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-gray-600">
          {AI_SUMMARY}
        </p>

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
          <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
            <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-2.5 text-xs font-medium text-gray-500">
              <Link2 className="h-3.5 w-3.5" /> Claude Code — .mcp.json
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
            No headers or keys — the client discovers the sign-in flow itself.
            Claude Desktop and Cursor connect the same way.
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
          <h2 className="text-2xl font-bold tracking-tight text-ink">
            Security
          </h2>
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-5">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
            <p className="text-sm leading-relaxed text-gray-600">
              {AI_SECURITY}
            </p>
          </div>
        </section>

        <section className="mt-14 rounded-2xl bg-ink px-6 py-12 text-center sm:px-12">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-white/10">
            <Bot className="h-6 w-6 text-white" />
          </div>
          <h2 className="mt-4 text-2xl font-bold tracking-tight text-white">
            Your expenses, on speaking terms with your assistant.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-gray-300">
            Accounts are free and start empty. Add your first receipt in under a
            minute, then connect your assistant whenever you're ready.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link to="/login?mode=create">Create your account</Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="ghost"
              className="w-full text-white hover:bg-white/10 hover:text-white sm:w-auto"
            >
              <Link to="/faq">Read the FAQ</Link>
            </Button>
          </div>
        </section>
      </main>
    </SitePage>
  );
}
