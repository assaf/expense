import type { ReactNode } from "react";
import { cn } from "cn";
import { FieldLabel } from "~/components/ui/FieldLabel";

/** Label + caption wrapper for a form control. The label wraps the control
 * directly, so clicking the label focuses the field via implicit
 * association (spec-compliant, works in all modern screen readers). */
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
      <FieldLabel>{label}</FieldLabel>
      {children}
    </label>
  );
}
