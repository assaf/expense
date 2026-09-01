import { Bot, Check, Link2, ShieldCheck, Sparkles } from "lucide-react";
import { Link } from "react-router";
import { MarketingCta, MarketingPage } from "~/components/MarketingPage";
import { cardSurface, Card } from "~/components/ui/Card";
import { cn } from "~/lib/cn";
import {
  AI_CAPABILITIES,
  AI_PROMPTS,
  AI_SECURITY,
  APP_NAME,
  AUTHOR_NAME,
  BLOG_URL,
  MCP_CLIENTS,
  MCP_ENDPOINT,
  MCP_PAGE_SUMMARY,
  MCP_TOOLS,
  marketingPageHeaders,
  pageMeta,
  SITE_URL,
} from "~/lib/seo-content";
import type { Route } from "./+types/connect";

const CONNECT_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: `${APP_NAME} MCP server`,
  url: `${SITE_URL}/connect`,
  description: MCP_PAGE_SUMMARY,
  author: {
    "@type": "Person",
    name: AUTHOR_NAME,
    url: BLOG_URL,
  },
};

export function meta(): Route.MetaDescriptors {
  return pageMeta(
    `${APP_NAME}: MCP server`,
    "Install instructions for the Expense MCP server in Claude, Cursor, VS Code, ChatGPT, and other MCP clients, the full tool list, and example usage. Remote HTTP + OAuth, no API keys.",
    "/connect",
  );
}

export const headers = marketingPageHeaders;

/** A labeled config snippet: header bar like the /ai code block, body verbatim. */
function CodeBlock({ label, body }: { label: string; body: string }) {
  return (
    <div
      className="mt-3 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700
        bg-gray-50 dark:bg-gray-900"
    >
      <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2.5 text-xs font-medium text-gray-500 dark:text-gray-400">
        <Link2 aria-hidden="true" className="h-3.5 w-3.5" /> {label}
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-sm text-gray-700 dark:text-gray-200">
        <code>{body}</code>
      </pre>
    </div>
  );
}

export default function ConnectPage() {
  return (
    <MarketingPage
      eyebrow="MCP server"
      title="Connect any AI assistant to Expense."
      summary={MCP_PAGE_SUMMARY}
      schema={
        <script type="application/ld+json">
          {JSON.stringify(CONNECT_SCHEMA)}
        </script>
      }
    >
      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          The endpoint
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          The base MCP server address is:
        </p>
        <div
          className="mt-4 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700
          bg-gray-50 dark:bg-gray-900"
        >
          <pre className="overflow-x-auto px-4 py-3 text-sm text-gray-700 dark:text-gray-200">
            <code>{MCP_ENDPOINT}</code>
          </pre>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          All connections use OAuth: the first connection opens a sign-in flow
          to your Expense account. No API keys.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          What your assistant can do
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {AI_CAPABILITIES.map((c) => (
            <Card key={c.title} className="p-5">
              <h3 className="font-semibold text-ink">{c.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                {c.body}
              </p>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">Tools</h2>
        <div className="mt-6 overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                <th className="px-4 py-3 font-semibold text-ink">Tool</th>
                <th className="px-4 py-3 font-semibold text-ink">Writes</th>
                <th className="px-4 py-3 font-semibold text-ink">
                  What it does
                </th>
              </tr>
            </thead>
            <tbody>
              {MCP_TOOLS.map((t) => (
                <tr
                  key={t.name}
                  className="border-b border-gray-100 dark:border-gray-800 last:border-0"
                >
                  <th
                    scope="row"
                    className="px-4 py-3 align-top font-mono text-[13px] font-medium text-ink"
                  >
                    {t.name}
                  </th>
                  <td className="px-4 py-3 align-top text-sm text-gray-700 dark:text-gray-200">
                    {t.writes ? (
                      <>
                        <Check
                          aria-hidden="true"
                          className="h-4 w-4 text-blue-600 dark:text-blue-400"
                        />
                        <span className="sr-only">yes</span>
                      </>
                    ) : (
                      "no"
                    )}
                  </td>
                  <td className="px-4 py-3 align-top leading-relaxed text-gray-700 dark:text-gray-200">
                    {t.what}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          Example prompts
        </h2>
        <ul className="mt-6 flex flex-col gap-3">
          {AI_PROMPTS.map((prompt) => (
            <li
              key={prompt}
              className={cn(cardSurface, "flex items-start gap-2 p-4")}
            >
              <Sparkles
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
              />
              <span className="text-sm leading-relaxed text-gray-700 dark:text-gray-200">
                {prompt}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          Setup instructions
        </h2>
        <div className="mt-6 flex flex-col gap-4">
          {MCP_CLIENTS.map((c) => (
            <Card key={c.id} className="p-5">
              <h3 className="font-semibold text-ink">{c.name}</h3>
              <ol className="mt-3 flex flex-col gap-1.5">
                {c.steps.map((step, i) => (
                  <li
                    key={i}
                    className="flex gap-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300"
                  >
                    <span className="shrink-0 font-medium text-gray-500 dark:text-gray-400">
                      {i + 1}.
                    </span>
                    <span>
                      {step}
                      {/*
                       * A step that ends with a colon introduces the config
                       * snippet, so the block renders inside that list item:
                       * the order (step, code, next step) matches the data.
                       */}
                      {c.code && step.endsWith(":") ? (
                        <CodeBlock
                          label={`${c.name}: ${c.code.lang}`}
                          body={c.code.body}
                        />
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
              {c.note ? (
                <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                  {c.note}
                </p>
              ) : null}
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink">Security</h2>
        <Card className="mt-6 flex items-start gap-3 p-5">
          <ShieldCheck
            aria-hidden="true"
            className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400"
          />
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">
            {AI_SECURITY}
          </p>
        </Card>
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          Signed in? Manage or revoke existing connections in Settings → Agents
          &amp; API (MCP). For the read-only in-page tools a browser agent can
          use while you're signed in, see{" "}
          <Link
            to="/ai"
            className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
          >
            the WebMCP page
          </Link>
          .
        </p>
      </section>

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
