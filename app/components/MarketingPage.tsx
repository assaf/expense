import type { ReactNode } from "react";
import { Link } from "react-router";
import { SitePage } from "~/components/SitePage";
import { Button } from "~/components/ui/Button";
import { cn } from "cn";

/**
 * Shared layout for the public marketing/SEO subpages (/about, /ai, /faq,
 * /alternatives): the site chrome plus the standard hero (eyebrow label,
 * display heading, and summary paragraph), with the page body and an
 * optional dark CTA panel inside the same max-width container. The four
 * pages used to hand-write this shell; it lives here so the hero and the
 * CTA stay visually identical.
 */

export function MarketingPage({
  eyebrow,
  title,
  summary,
  schema,
  className,
  children,
}: {
  /** Small uppercase label above the heading ("About", "FAQ", …). */
  eyebrow: string;
  /** The page's display heading. */
  title: ReactNode;
  /** One-paragraph page summary under the heading. */
  summary: ReactNode;
  /** JSON-LD <script> blocks rendered before the main content. */
  schema?: ReactNode;
  /** Container classes: override the default max-w-4xl (FAQ uses max-w-3xl). */
  className?: string;
  children?: ReactNode;
}) {
  return (
    <SitePage>
      {schema}
      <main
        className={cn(
          "mx-auto px-4 pb-16 pt-12 sm:px-6 flex flex-col gap-4",
          className ?? "max-w-4xl",
        )}
      >
        <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-blue-600 dark:text-blue-400">
          {eyebrow}
        </p>
        <h1 className="text-4xl font-black tracking-tight text-ink sm:text-5xl">
          {title}
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-gray-600 dark:text-gray-300">
          {summary}
        </p>
        {children}
      </main>
    </SitePage>
  );
}

/**
 * The dark "create your account" panel that closes every marketing page:
 * ink background, centered heading + body, and a primary CTA button (white
 * variant on FAQ/Compare) with an optional ghost secondary button. The panel
 * always links to the signup; pages only vary the copy, the icon, the
 * heading size, and the spacing.
 */
export function MarketingCta({
  heading,
  body,
  icon,
  primaryLabel = "Create your account",
  secondaryLabel,
  secondaryHref,
  className,
  buttonRow = "mt-8",
  headingClassName,
  secondaryClassName,
}: {
  heading: ReactNode;
  body: ReactNode;
  /** Optional icon shown above the heading (e.g. the AI page's bot). */
  icon?: ReactNode;
  primaryLabel?: string;
  /** Optional ghost secondary button next to the primary. */
  secondaryLabel?: string;
  secondaryHref?: string;
  /** Panel classes for top margin (mt-12 on FAQ/Compare) and padding. */
  className?: string;
  /** Button-row margin (mt-6 on FAQ/Compare). */
  buttonRow?: string;
  /** Heading size override (the landing page's closing panel uses text-3xl). */
  headingClassName?: string;
  /** Secondary-button style override (the landing page's "Sign in" is
   * transparent instead of blue). */
  secondaryClassName?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl bg-gray-900 px-6 py-12 text-center sm:px-12",
        className,
      )}
    >
      {icon ? (
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-white/10">
          {icon}
        </div>
      ) : null}
      <h2
        className={cn(
          "text-2xl font-bold tracking-tight text-white",
          headingClassName,
          icon ? "mt-4" : "",
        )}
      >
        {heading}
      </h2>
      <p className="mx-auto mt-3 max-w-md text-gray-300">{body}</p>
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-3 sm:flex-row",
          buttonRow,
        )}
      >
        <Button
          asChild
          size="lg"
          className="w-full bg-white dark:bg-gray-700 text-ink hover:bg-gray-100 dark:hover:bg-gray-800 sm:w-auto"
        >
          <Link to="/login?mode=create">{primaryLabel}</Link>
        </Button>
        {secondaryLabel && secondaryHref ? (
          <Button
            asChild
            size="lg"
            variant="ghost"
            className={cn(
              "w-full text-white hover:bg-white/10 hover:text-white sm:w-auto bg-blue-600",
              secondaryClassName,
            )}
          >
            <Link to={secondaryHref}>{secondaryLabel}</Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
