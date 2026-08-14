import type { DragEvent, ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";

/**
 * Optional drag-and-drop target for the page shell: while a file is dragged
 * over the page a dashed outline shows, and the drop handlers fire on
 * release. Used by the receipt editor so a receipt file can be dropped
 * anywhere on the page to replace/upload it. Handlers are attached to the
 * same <main> as the home page's drop zone, so the outline hugs the card.
 */
export type DropTarget = {
  over: boolean;
  onDragEnter: (e: DragEvent<HTMLElement>) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
};

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
  drop,
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
  /** Drag-and-drop target handlers + outline (receipt editor). */
  drop?: DropTarget;
  children: ReactNode;
}) {
  return (
    <main
      id="main-content"
      className={`mx-auto max-w-2xl px-4 py-8 transition-opacity duration-150 ${dimmed ? "pointer-events-none opacity-80" : ""} ${drop?.over ? "outline-dashed outline-2 -outline-offset-2 outline-blue-500 dark:outline-blue-400" : ""}`}
      {...(drop
        ? {
            onDragEnter: drop.onDragEnter,
            onDragOver: drop.onDragOver,
            onDragLeave: drop.onDragLeave,
            onDrop: drop.onDrop,
          }
        : {})}
    >
      <div className="mb-4 flex items-center justify-between">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-ink dark:hover:text-gray-100"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back
          </button>
        ) : (
          <Link
            to={backTo}
            className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-ink dark:hover:text-gray-100"
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
