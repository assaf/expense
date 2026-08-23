import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

interface AlertProps {
  /** Prepend the AlertCircle icon and lay the banner out horizontally. */
  icon?: boolean;
  className?: string;
  children: ReactNode;
}

/** The shared inline error banner (`role="alert"`): a soft red strip for
 * form/action failures. Pass `icon` for the circled-exclamation variant
 * used inside forms; `className` extends or overrides (e.g. font weight). */
export function Alert({ icon, className, children }: AlertProps) {
  return (
    <p
      role="alert"
      className={cn(
        "rounded-lg bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-600 dark:text-red-400",
        icon && "flex items-center gap-2",
        className,
      )}
    >
      {icon ? (
        <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
      ) : null}
      {children}
    </p>
  );
}
