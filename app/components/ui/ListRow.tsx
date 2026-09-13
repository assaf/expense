import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "cn";

/**
 * The row treatment the settings lists share: one line, backgrounded, amber
 * for a few seconds after the row was just added.
 */
export function ListRow({
  flash,
  rowRef,
  className,
  children,
}: {
  /** True while this row is the one just added. */
  flash?: boolean;
  /** `useFlashRow`'s ref: the flashed row scrolls itself into view. */
  rowRef?: RefObject<HTMLLIElement | null>;
  className?: string;
  children: ReactNode;
}) {
  return (
    <li
      ref={flash ? rowRef : undefined}
      className={cn(
        "flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 transition-colors duration-500",
        flash
          ? "bg-amber-200 dark:bg-amber-800"
          : "bg-gray-50 dark:bg-gray-900",
        className,
      )}
    >
      {children}
    </li>
  );
}

/** Which row to flash after a successful add: key it by whatever the row has
 * (id, name), scroll it into view, and drop the highlight a few seconds
 * later. The caller still owns the announcement and when an add happened. */
export function useFlashRow<K>({ timeoutMs = 3000 } = {}): {
  flashKey: K | null;
  rowRef: RefObject<HTMLLIElement | null>;
  flash: (key: K) => void;
} {
  const [flashKey, setFlashKey] = useState<K | null>(null);
  const rowRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (flashKey === null) return;
    rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const timer = setTimeout(() => setFlashKey(null), timeoutMs);
    return () => clearTimeout(timer);
  }, [flashKey, timeoutMs]);
  return { flashKey, rowRef, flash: setFlashKey };
}
