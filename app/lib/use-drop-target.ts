import { useCallback, useRef, useState, type DragEvent } from "react";
import type { DropTarget } from "~/components/PageShell";

/**
 * Depth-counted drag-and-drop target state. dragenter/dragleave fire for
 * every child element crossed, so track depth instead of toggling on each
 * event — prevents the highlight from flickering. When `enabled` is false
 * every handler is inert and the drop is left to the browser's default
 * (which ignores it) — used to keep closed reports read-only.
 */
export function useDropTarget({
  enabled = true,
  accepts,
  onFile,
  message,
}: {
  /** When false, no highlight and drops fall through to the browser. */
  enabled?: boolean;
  /** Predicate deciding whether a dropped file is accepted. */
  accepts: (file: File) => boolean;
  /** Called with the first dropped file when it passes `accepts`. */
  onFile: (file: File) => void;
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
      const file = e.dataTransfer.files?.[0];
      if (file && accepts(file)) onFile(file);
    },
    [accepts, enabled, onFile],
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
