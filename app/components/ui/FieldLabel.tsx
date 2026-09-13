import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * The label treatment: `Field` wraps its control with this, and the
 * read-only rows that show a value instead of an input use it directly, so
 * every label in the app is the same size and weight.
 */
export function FieldLabel({
  as: Tag = "span",
  muted,
  className,
  children,
}: {
  as?: "span" | "div";
  /** The lighter tone the read-only settings rows use. */
  muted?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      className={cn(
        "text-sm font-medium",
        muted
          ? "text-gray-500 dark:text-gray-400"
          : "text-gray-700 dark:text-gray-200",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
