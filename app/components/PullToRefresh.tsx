import { Loader2 } from "lucide-react";

import type { PullToRefresh } from "~/lib/use-pull-to-refresh";

/**
 * The pull-to-refresh affordance: a spinner that comes down with the finger
 * and stays while the list reloads.
 *
 * It is the app's own, because in a Home Screen app the browser's reload
 * gesture does not exist (see `usePullToRefresh`). It sits in the middle of
 * the top edge, where the page's header has nothing between the wordmark
 * and the navigation, and it never takes a tap: the gesture is the whole
 * interaction, and the button would be a second, redundant way to do it.
 */
export function PullToRefreshIndicator({
  pull,
  armed,
  refreshing,
}: PullToRefresh) {
  const visible = pull > 0 || refreshing;
  return (
    <div
      role="status"
      aria-hidden={!refreshing}
      data-pull-to-refresh={
        refreshing
          ? "refreshing"
          : armed
            ? "armed"
            : pull > 0
              ? "pulling"
              : "idle"
      }
      className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center transition-[transform,opacity] duration-200"
      style={{ transform: `translateY(${visible ? pull * 0.6 : 0}px)` }}
    >
      <span
        className={`mt-2 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 shadow-sm ring-1 ring-gray-200 transition-opacity duration-150 dark:bg-gray-800/90 dark:ring-gray-700 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      >
        <Loader2
          aria-hidden="true"
          className={`h-4 w-4 text-teal-600 transition-transform duration-150 dark:text-teal-400 ${
            armed ? "rotate-180" : ""
          } ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
        />
      </span>
      <span className="sr-only">{refreshing ? "Refreshing the list" : ""}</span>
    </div>
  );
}
