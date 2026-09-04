import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "cn";

interface AlertProps {
  /** Prepend the AlertCircle icon and lay the banner out horizontally. */
  icon?: boolean;
  /** Panel treatment for standalone banners: bordered, rounded-xl, and
   * roomier padding (vs the default bare inline strip). */
  bordered?: boolean;
  className?: string;
  children: ReactNode;
}

/** The shared error banner (`role="alert"`): a soft red strip for
 * form/action failures. Pass `icon` for the circled-exclamation variant
 * used inside forms, `bordered` for the standalone panel, and
 * `className` to extend or override. */
export function Alert({ icon, bordered, className, children }: AlertProps) {
  return (
    <p
      role="alert"
      className={cn(
        "rounded-lg bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-600 dark:text-red-400",
        bordered &&
          "rounded-xl border border-red-200 px-4 py-3 dark:border-red-900/60 dark:bg-red-950/40",
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
