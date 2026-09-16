import { ShieldCheck, Sparkles } from "lucide-react";
import { InlineMarkdown } from "~/components/Markdown";
import { Card, cardSurface } from "~/components/ui/Card";
import { cn } from "cn";

/**
 * Marketing sections shared verbatim by the two MCP pages (/ai and
 * /connect), so the pages can't drift apart on copy layout. The copy
 * arrives from `app/data/mcp.yaml` through each page's loader: only the
 * layout and the class names live here.
 */

/** "What your assistant can do": one card per capability. */
export function CapabilitiesSection({
  heading,
  capabilities,
}: {
  heading: string;
  capabilities: Array<{ title: string; body: string }>;
}) {
  return (
    <section className="mt-14">
      <h2 className="text-2xl font-bold tracking-tight text-ink">{heading}</h2>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {capabilities.map((c) => (
          <Card key={c.title} className="p-5">
            <h3 className="font-semibold text-ink">{c.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
              {c.body}
            </p>
          </Card>
        ))}
      </div>
    </section>
  );
}

/** Example prompts; the heading differs per page. */
export function PromptsSection({
  heading,
  prompts,
}: {
  heading: string;
  prompts: string[];
}) {
  return (
    <section className="mt-14">
      <h2 className="text-2xl font-bold tracking-tight text-ink">{heading}</h2>
      <ul className="mt-6 flex flex-col gap-3">
        {prompts.map((prompt) => (
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
  );
}

/** Security card; an optional page-specific footnote renders under it. */
export function SecuritySection({
  heading,
  security,
  note,
}: {
  heading: string;
  security: string;
  /** Optional page-specific footnote, rendered under the card. */
  note?: string;
}) {
  return (
    <section className="mt-14">
      <h2 className="text-2xl font-bold tracking-tight text-ink">{heading}</h2>
      <Card className="mt-6 flex items-start gap-3 p-5">
        <ShieldCheck
          aria-hidden="true"
          className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400"
        />
        <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          {security}
        </p>
      </Card>
      {note ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          <InlineMarkdown text={note} />
        </p>
      ) : null}
    </section>
  );
}
