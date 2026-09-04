import { ShieldCheck, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Card, cardSurface } from "~/components/ui/Card";
import { cn } from "cn";
import { AI_CAPABILITIES, AI_PROMPTS, AI_SECURITY } from "~/lib/seo-content";

/**
 * Marketing sections shared verbatim by the two MCP pages (/ai and
 * /connect), so the pages can't drift apart on copy layout.
 */

/** "What your assistant can do": one card per capability. */
export function CapabilitiesSection() {
  return (
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
  );
}

/** Example prompts; the heading differs per page. */
export function PromptsSection({ heading }: { heading: string }) {
  return (
    <section className="mt-14">
      <h2 className="text-2xl font-bold tracking-tight text-ink">{heading}</h2>
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
  );
}

/** Security card; page-specific notes render inside the section, after it. */
export function SecuritySection({ children }: { children?: ReactNode }) {
  return (
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
      {children}
    </section>
  );
}
