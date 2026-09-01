import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";

import { ACTION_SHORTCUTS } from "~/components/command-palette";

/**
 * Shift+? shortcut hints, the FastMail trick: pressing ? pins a keycap next
 * to every element the palette shortcuts drive (nav buttons, the create
 * buttons, the search box), so the keys are discovered in place instead of
 * memorized from the palette. Press ? again (or Escape) to dismiss.
 *
 * The chords come from ACTION_SHORTCUTS in command-palette.tsx, so the
 * palette, its results list, and these badges share one table and can't
 * drift apart. Anchors are plain `data-shortcut` attributes on the page
 * named after the kbar action ids: an action whose anchor isn't rendered
 * on the current page simply shows no badge. The layer is aria-hidden and
 * pointer-events-none: it is a visual aid, the palette itself is the
 * accessible list of shortcuts.
 */

/** Badge per palette shortcut chord, in the table's own order. */
const HINTS = Object.entries(ACTION_SHORTCUTS).map(([name, keys]) => ({
  name,
  keys,
}));

/** Where typing ? must stay typing: inputs, textareas, and editable hosts. */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

/** One positioned keycap row. Coordinates are viewport-relative, so the
 * layer tracks its anchors through scrolls without any page math. */
type Badge = { name: string; keys: string[]; left: number; top: number };

/** Measure the first visible anchor per hint. Hidden elements (a different
 * page's chrome) produce no badge, which is what keeps the sheet contextual:
 * only the shortcuts that mean something on this screen show up. Badges sit
 * centered above their anchor: the app's controls sit in tight rows, so a
 * badge to the right would cover the neighboring button. */
function measure(): Badge[] {
  const badges: Badge[] = [];
  for (const hint of HINTS) {
    const el = document.querySelector(`[data-shortcut="${hint.name}"]`);
    if (!el || el.getClientRects().length === 0) continue;
    const rect = el.getBoundingClientRect();
    badges.push({
      name: hint.name,
      keys: hint.keys,
      left: rect.left + rect.width / 2,
      top: Math.max(rect.top - 6, 4),
    });
  }
  return badges;
}

export function ShortcutHints() {
  const [active, setActive] = useState(false);
  const [badges, setBadges] = useState<Badge[]>([]);
  const { pathname } = useLocation();

  // The toggle listens even while the layer is closed (that is the point).
  // Modifier chords are skipped so Cmd+Shift+? style OS shortcuts pass
  // through, and preventDefault stops Firefox's quick-find from opening
  // on the same keystroke.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      setActive((a) => !a);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // While open: Escape dismisses, and the badges re-measure on scroll and
  // resize so they stay glued to their anchors. The rAF throttle collapses
  // scroll bursts into one measurement per frame.
  useEffect(() => {
    if (!active) return;
    function onEscape(e: KeyboardEvent) {
      if (e.key !== "Escape" || isEditableTarget(e.target)) return;
      setActive(false);
    }
    let frame = 0;
    function remeasure() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBadges(measure()));
    }
    remeasure();
    document.addEventListener("keydown", onEscape);
    window.addEventListener("resize", remeasure);
    document.addEventListener("scroll", remeasure, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onEscape);
      window.removeEventListener("resize", remeasure);
      document.removeEventListener("scroll", remeasure, true);
    };
  }, [active, pathname]);

  if (!active) return null;
  return createPortal(
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-50">
      {badges.map((badge) => (
        <span
          key={badge.name}
          data-shortcut-hint={badge.name}
          className="absolute flex -translate-x-1/2 -translate-y-full gap-0.5"
          style={{ left: badge.left, top: badge.top }}
        >
          {badge.keys.map((key) => (
            <kbd
              key={key}
              className="rounded-md bg-gray-800 px-1.5 py-0.5 text-[11px] font-semibold uppercase leading-4 text-white shadow-sm dark:bg-gray-600 dark:text-white"
            >
              {key}
            </kbd>
          ))}
        </span>
      ))}
    </div>,
    document.body,
  );
}
