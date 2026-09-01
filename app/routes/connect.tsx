import { Bot, Check, Copy, Link2, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
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
    "Install instructions for the Expense MCP server in Claude, ChatGPT, Gemini CLI, and other MCP clients, the full tool list, and example usage. Remote HTTP + OAuth, no API keys.",
    "/connect",
  );
}

export const headers = marketingPageHeaders;

/** One-click copy for a snippet: the icon swaps to a check for two seconds. */
function CopyButton({
  text,
  label,
  inline = false,
}: {
  text: string;
  label: string;
  inline?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Clipboard unavailable (blocked or insecure context); the text stays selectable.
          return;
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className={
        inline
          ? "inline-block rounded-md p-0.5 align-middle text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          : "ml-auto rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300"
      }
    >
      {copied ? (
        <Check
          aria-hidden="true"
          className={inline ? "h-3.5 w-3.5" : "h-4 w-4"}
        />
      ) : (
        <Copy
          aria-hidden="true"
          className={inline ? "h-3.5 w-3.5" : "h-4 w-4"}
        />
      )}
    </button>
  );
}

/** A labeled config snippet with one-click copy: header bar like the /ai code block, body verbatim. */
function CodeBlock({
  label,
  body,
  copyLabel = "Copy config",
}: {
  label: string;
  body: string;
  copyLabel?: string;
}) {
  return (
    <div
      className="mt-3 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700
        bg-gray-50 dark:bg-gray-900"
    >
      <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2.5 text-xs font-medium text-gray-500 dark:text-gray-400">
        <Link2 aria-hidden="true" className="h-3.5 w-3.5" /> {label}
        <CopyButton text={body} label={copyLabel} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-sm text-gray-700 dark:text-gray-200">
        <code>{body}</code>
      </pre>
    </div>
  );
}

/** Step text: an embedded server URL becomes a monospace chip with its own one-click copy. */
function StepText({ text }: { text: string }) {
  const urlAt = text.indexOf(MCP_ENDPOINT);
  if (urlAt === -1) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, urlAt)}
      <code className="break-all rounded bg-gray-100 px-1 py-0.5 font-mono text-[13px] text-gray-700 dark:bg-gray-800 dark:text-gray-200">
        {MCP_ENDPOINT}
      </code>
      <CopyButton text={MCP_ENDPOINT} label="Copy server URL" inline />
      {text.slice(urlAt + MCP_ENDPOINT.length)}
    </>
  );
}

export default function ConnectPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("client");
  // Unknown ids fall back to the first client; the default client keeps the
  // canonical /connect URL (no ?client= in the link).
  const active = MCP_CLIENTS.find((c) => c.id === requested) ?? MCP_CLIENTS[0];
  const selectClient = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id === MCP_CLIENTS[0].id) {
      next.delete("client");
    } else {
      next.set("client", id);
    }
    setSearchParams(next, { preventScrollReset: true });
  };
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
          Setup instructions
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          The base MCP server address is:
        </p>
        <CodeBlock
          label="Server URL"
          body={MCP_ENDPOINT}
          copyLabel="Copy server URL"
        />
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          All connections use OAuth: the first connection opens a sign-in flow
          to your Expense account. No API keys.
        </p>

        <div className="mt-8 flex flex-wrap gap-2">
          {MCP_CLIENTS.map((c) => {
            const selected = c.id === active.id;
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={selected}
                onClick={() => selectClient(c.id)}
                className={cn(
                  "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                  selected
                    ? "border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600 dark:hover:text-gray-100",
                )}
              >
                {c.short ?? c.name}
              </button>
            );
          })}
        </div>

        <Card key={active.id} className="mt-4 p-5">
          <h3 className="font-semibold text-ink">{active.name}</h3>
          <ol className="mt-3 flex flex-col gap-1.5">
            {active.steps.map((step, i) => (
              <li
                key={i}
                className="flex gap-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300"
              >
                <span className="shrink-0 font-medium text-gray-500 dark:text-gray-400">
                  {i + 1}.
                </span>
                <span>
                  <StepText text={step} />
                  {/*
                   * A step that ends with a colon introduces the config
                   * snippet, so the block renders inside that list item:
                   * the order (step, code, next step) matches the data.
                   */}
                  {active.code && step.endsWith(":") ? (
                    <CodeBlock
                      label={`${active.name}: ${active.code.lang}`}
                      body={active.code.body}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
          {active.note ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              {active.note}
            </p>
          ) : null}
        </Card>
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
