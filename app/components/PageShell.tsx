import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";

/**
 * Shared page chrome: an optional Back link/button + a page title, inside
 * the standard max-w-2xl container. Used by Settings, Export, and the
 * expense editor shell.
 */
export function PageShell({
  title,
  backTo = "/",
  onBack,
  headerRight,
  dimmed,
  children,
}: {
  title: string;
  /** Where the Back link goes (default: the home page). */
  backTo?: string;
  /** When set, renders a Back button that calls this instead of a link. */
  onBack?: () => void;
  /** Optional content on the right side of the header row (e.g. editor nav). */
  headerRight?: ReactNode;
  /** Fade the content while a save/cancel navigation is in flight. */
  dimmed?: boolean;
  children: ReactNode;
}) {
  return (
    <main
      id="main-content"
      className={`mx-auto max-w-2xl px-4 py-8 transition-opacity duration-150 ${dimmed ? "pointer-events-none opacity-80" : ""}`}
    >
      <div className="mb-4 flex items-center justify-between">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-ink"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back
          </button>
        ) : (
          <Link
            to={backTo}
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-ink"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back
          </Link>
        )}
        {headerRight ?? null}
      </div>
      <h1 className="mb-6 text-2xl font-bold">{title}</h1>
      {children}
    </main>
  );
}
