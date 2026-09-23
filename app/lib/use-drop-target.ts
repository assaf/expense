import { useEffect, useEffectEvent, useRef, useState } from "react";

/**
 * Everything a drop zone needs: the hook that tracks the drag state and the
 * outline class it shows while a file is over it. The home list, the receipt
 * editor, the warranty editor, and the reconcile landing all read from here,
 * so no two of them can highlight differently.
 *
 * The listeners live on the document rather than on a container: a file can
 * be dropped anywhere on the page, margins included, and the browser's own
 * "navigate to the file it was handed" is prevented along with it. What wears
 * the outline is still the content column (callers read `over`), which is what
 * makes the target obvious without shrinking it to a box.
 *
 * One drop target per page: two enabled at once would both take the drop.
 */

/** What a drop target publishes. The listeners are the hook's own (see
 * useDropTarget), so nothing has to be spread on a container to arm it. */
export interface DropTarget {
  /** True while a file is being dragged over the page. */
  over: boolean;
  /** Live-region text shown while a file is over the page. */
  message: string;
}

/** Dashed outline while a file is over the page. */
export const DROP_OUTLINE =
  "outline-dashed outline-2 -outline-offset-2 outline-blue-500 dark:outline-blue-400";

/** Whether this drag carries files. A text or link drag must not light up a
 * file target, nor be intercepted on its way to the browser. */
function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types?.includes("Files") ?? false;
}

/**
 * Depth-counted drag-and-drop target state. dragenter/dragleave fire for
 * every child element crossed, so track depth instead of toggling on each
 * event, which prevents the highlight from flickering. When `enabled` is false
 * nothing listens and the drop is left to the browser's default (which
 * ignores it); this is used to keep closed reports read-only.
 */
export function useDropTarget({
  enabled = true,
  accepts,
  onFiles,
  message,
}: {
  /** When false, no highlight and drops fall through to the browser. */
  enabled?: boolean;
  /** Predicate deciding whether a dropped file is accepted. */
  accepts: (file: File) => boolean;
  /** Called with every dropped file that passed `accepts`, in drop order.
   * Zones that hold one file (the receipt editor, a statement) take the
   * first; a multi-file zone (warranty documents) keeps them all. */
  onFiles: (files: File[]) => void;
  /** Live-region text shown while a file hovers (consumer-specific verb). */
  message: string;
}): DropTarget {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  // Effect events: consumers pass fresh arrows every render, and these keep
  // the document listeners installed once while still seeing the latest
  // props (`useFormKeys` in the editors reads them the same way).
  const onEnter = useEffectEvent((e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  });

  const onOver = useEffectEvent((e: DragEvent) => {
    if (!hasFiles(e)) return;
    // preventDefault is what makes any spot on the page a drop target: without
    // it the browser rejects the drop outside a registered area, and hands the
    // file to itself (navigating away from the app).
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });

  const onLeave = useEffectEvent((e: DragEvent) => {
    // Leaving the window skips the per-element dragleave pair the depth count
    // relies on, so the drag would otherwise end with the outline still up.
    if (e.relatedTarget === null) {
      depth.current = 0;
      setOver(false);
      return;
    }
    depth.current -= 1;
    if (depth.current <= 0) {
      depth.current = 0;
      setOver(false);
    }
  });

  const onDrop = useEffectEvent((e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    const files = [...(e.dataTransfer?.files ?? [])].filter(accepts);
    if (files.length > 0) onFiles(files);
  });

  const onEnd = useEffectEvent(() => {
    depth.current = 0;
    setOver(false);
  });

  useEffect(() => {
    if (!enabled) return;
    document.addEventListener("dragenter", onEnter);
    document.addEventListener("dragover", onOver);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    document.addEventListener("dragend", onEnd);
    return () => {
      document.removeEventListener("dragenter", onEnter);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("dragend", onEnd);
      // A drag in flight when the zone goes away (a save starts, the report
      // closes, the route changes) must not leave the next page outlined.
      depth.current = 0;
      setOver(false);
    };
  }, [enabled]);

  return { over, message };
}
