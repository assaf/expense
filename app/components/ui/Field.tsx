import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/** Label + caption wrapper for a form control. The label wraps the control
 * directly, so clicking the label focuses the field (implicit association). */
export function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-sm font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}
