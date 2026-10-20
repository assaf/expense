import { useEffect, useRef, useState } from "react";

/** How far the finger has to pull before letting go refreshes. */
export const PULL_REFRESH_TRIGGER_PX = 72;

/** How far the indicator travels with the finger. */
const PULL_REFRESH_MAX_PX = 112;

export interface PullToRefresh {
  /** How far the finger has pulled, in pixels; 0 when it is not pulling. */
  pull: number;
  /** True once the pull is far enough that letting go would refresh. */
  armed: boolean;
  /** True from the moment the finger lets go until the refresh settles. */
  refreshing: boolean;
}

/**
 * Pull down to refresh, for the app on a phone.
 *
 * Safari's own pull-to-refresh is not available in a Home Screen app: iOS
 * gives the standalone web view no browser chrome, and the reload gesture is
 * part of that chrome. So the gesture belongs to the app — the finger pulls
 * an indicator down, and letting go past the trigger re-runs the page's
 * loader, which is what a reload would have done.
 *
 * Two rules keep it out of the way of a scroll:
 *
 * - It starts only at the top of the page. A pull further down is a scroll,
 *   and the person who makes it is reading, not refreshing.
 * - It claims the touch as it goes (`preventDefault` on the move, which needs
 *   a listener that is not passive). Without that the page rubber-bands
 *   under the finger, and in Safari the browser's own reload fires
 *   alongside this one — two refreshes for one gesture.
 *
 * The pull is a phone affordance, so the hook is a no-op without a touch
 * screen: it listens for touch events, and a device that has none never
 * sends them.
 */
export function usePullToRefresh(
  onRefresh: () => void | Promise<void>,
  enabled = true,
): PullToRefresh {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // The gesture's own state, in refs: the touch handlers are registered
  // once, and a handler that closes over React state would read the pull as
  // it was when the touch began.
  const startY = useRef<number | null>(null);
  const distance = useRef(0);
  const busy = useRef(false);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    if (!enabled) return;

    const onTouchStart = (event: TouchEvent): void => {
      if (busy.current) return;
      if (event.touches.length !== 1) return;
      // Only from the top: further down the page, a pull is a scroll.
      if (window.scrollY > 0) return;
      startY.current = event.touches[0]?.clientY ?? null;
    };

    const onTouchMove = (event: TouchEvent): void => {
      if (startY.current === null) return;
      const touch = event.touches[0];
      if (touch === undefined) return;
      const delta = touch.clientY - startY.current;
      if (delta <= 0) {
        // Back up towards where the finger started: the pull is over.
        distance.current = 0;
        setPull(0);
        return;
      }
      // Claim the gesture, so the page does not rubber-band under the finger
      // and the browser's own pull-to-refresh does not fire beside it.
      if (event.cancelable) event.preventDefault();
      const next = Math.min(delta, PULL_REFRESH_MAX_PX);
      distance.current = next;
      setPull(next);
    };

    const onTouchEnd = (): void => {
      if (startY.current === null) return;
      startY.current = null;
      const pulled = distance.current;
      distance.current = 0;
      setPull(0);
      if (pulled < PULL_REFRESH_TRIGGER_PX) return;
      busy.current = true;
      setRefreshing(true);
      void Promise.resolve(refresh.current())
        .catch(() => undefined)
        .finally(() => {
          busy.current = false;
          setRefreshing(false);
        });
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled]);

  return { pull, armed: pull >= PULL_REFRESH_TRIGGER_PX, refreshing };
}
