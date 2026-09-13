import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * One muted line: the "None yet." note a list shows when it is empty, or a
 * hint under a list or form. `as="li"` when it sits inside a list, so the
 * markup stays valid.
 */
export function StatusNote({
  as: Tag = "p",
  className,
  children,
}: {
  as?: "p" | "li" | "div";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={cn("text-sm text-gray-500 dark:text-gray-400", className)}>
      {children}
    </Tag>
  );
}
