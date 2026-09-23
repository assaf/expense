import { useCallback, useRef, useState, type DragEvent } from "react";

/**
 * Everything a drop zone needs: the hook that tracks the drag state, the
 * handlers a container spreads, and the outline class it shows while a file
 * is over it. The home list, the receipt editor, the warranty editor, and
 * the reconcile landing all read from here, so no two of them can highlight
 * differently.
 */

/** A drop target's state and handlers, as a page's container spreads them. */
export interface DropTarget {
  over: boolean;
  onDragEnter: (e: DragEvent<HTMLElement>) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

/** Dashed outline while a file is over the page. */
export const DROP_OUTLINE =
  "outline-dashed outline-2 -outline-offset-2 outline-blue-500 dark:outline-blue-400";

/** The four handler props for a drop container, or nothing when the page has
 * no drop target (an undroppable page must not look droppable). */
export function dropHandlers(drop?: DropTarget): Partial<DropTarget> {
  if (!drop) return {};
  return {
    onDragEnter: drop.onDragEnter,
    onDragOver: drop.onDragOver,
    onDragLeave: drop.onDragLeave,
    onDrop: drop.onDrop,
  };
}

/**
 * Depth-counted drag-and-drop target state. dragenter/dragleave fire for
 * every child element crossed, so track depth instead of toggling on each
 * event, which prevents the highlight from flickering. When `enabled` is false
 * every handler is inert and the drop is left to the browser's default
 * (which ignores it); this is used to keep closed reports read-only.
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
}): DropTarget & {
  /** Text for an sr-only live region while a file is over the page. */
  message: string;
} {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!enabled) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    [enabled],
  );

  const onDragOver = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!enabled) return;
      // preventDefault is required to turn the drag into a drop target.
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [enabled],
  );

  const onDragLeave = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!enabled) return;
      e.preventDefault();
      depth.current -= 1;
      if (depth.current <= 0) {
        depth.current = 0;
        setOver(false);
      }
    },
    [enabled],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!enabled) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const files = [...(e.dataTransfer.files ?? [])].filter(accepts);
      if (files.length > 0) onFiles(files);
    },
    [accepts, enabled, onFiles],
  );

  return {
    over,
    message: over ? message : "",
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}
