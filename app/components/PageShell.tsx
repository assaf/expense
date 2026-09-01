import type { DragEvent, ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "~/components/ui/Button";

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
 * Shared page chrome inside the standard centered container, in one of two
 * layouts:
 * - Editor shell (default): an optional Back link/button row above the page
 *   title, with optional headerRight content beside it.
 * - Standalone pages (pass `icon`): Settings, Export, Emails, Reconcile and
 *   the inbox review page render a single toolbar row: icon + title on the
 *   left, actions and a ghost Back button on the right.
 */
export function PageShell({
  icon,
  title,
  backTo = "/",
  backLabel = "Back to expenses",
  onBack,
  headerRight,
  className,
  maxWidth = "max-w-2xl",
  dimmed,
  drop,
  children,
}: {
  /** Optional icon at the start of the h1; passing it selects the toolbar
   * layout described above. The editor shell omits it. */
  icon?: ReactNode;
  /** Page heading. */
  title: ReactNode;
  /** Where the Back control goes (default: the home page). */
  backTo?: string;
  /** Toolbar-layout Back label (default: "Back to expenses"). */
  backLabel?: string;
  /** When set, renders a Back button that calls this instead of a link. */
  onBack?: () => void;
  /** Optional content on the right side of the header row (e.g. editor nav). */
  headerRight?: ReactNode;
  /** Extra classes on the <main> element (e.g. page hooks like settings-page). */
  className?: string;
  /** Max-width utility for the container (default: max-w-2xl). */
  maxWidth?: string;
  /** Fade the content while a save/cancel navigation is in flight. */
  dimmed?: boolean;
  /** Drag-and-drop target handlers + outline (receipt editor). */
  drop?: DropTarget;
  children: ReactNode;
}) {
  const dropHandlers = drop
    ? {
        onDragEnter: drop.onDragEnter,
        onDragOver: drop.onDragOver,
        onDragLeave: drop.onDragLeave,
        onDrop: drop.onDrop,
      }
    : {};
  // The Shift+? hint layer pins "G E" on the control that goes home; the
  // email-review back link goes to /emails, so it must not claim the chord.
  const homeShortcut = backTo === "/" ? "nav-expenses" : undefined;
  const containerClass = [className, "mx-auto", maxWidth, "px-4 py-8"]
    .filter(Boolean)
    .join(" ");

  // Toolbar layout (`icon` set): the standalone pages put the titled heading
  // and their actions on one wrapping row. Static; no dim transition.
  if (icon) {
    return (
      <main id="main-content" className={containerClass} {...dropHandlers}>
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            {icon}
            {title}
          </h1>
          <div className="flex items-center gap-2">
            {headerRight ?? null}
            <Button asChild variant="ghost" size="sm">
              <Link to={backTo} data-shortcut={homeShortcut}>
                <ArrowLeft aria-hidden="true" className="h-4 w-4" /> {backLabel}
              </Link>
            </Button>
          </div>
        </header>
        {children}
      </main>
    );
  }

  return (
    <main
      id="main-content"
      className={`mx-auto ${maxWidth} px-4 py-8 transition-opacity duration-150 ${dimmed ? "pointer-events-none opacity-80" : ""} ${drop?.over ? "outline-dashed outline-2 -outline-offset-2 outline-blue-500 dark:outline-blue-400" : ""}`}
      {...dropHandlers}
    >
      <div className="mb-4 flex items-center justify-between">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            data-shortcut={homeShortcut}
            className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-ink dark:hover:text-gray-100"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back
          </button>
        ) : (
          <Link
            to={backTo}
            data-shortcut={homeShortcut}
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
