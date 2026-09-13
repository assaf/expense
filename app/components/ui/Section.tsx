import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * A titled page section: the shell the settings family renders around every
 * group of fields. The `id` is what other surfaces link to (`#categories`,
 * `#start-location`, `#agents`), so it and the scroll margin travel
 * together.
 */
export function Section({
  id,
  title,
  icon,
  className,
  children,
}: {
  /** Anchor id, when anything links here; `scroll-mt-6` keeps the heading
   * clear of the sticky chrome. */
  id?: string;
  title: ReactNode;
  /** Leading icon: the heading becomes a flex row to seat it. */
  icon?: ReactNode;
  /** Replaces the default spacing (`mb-8 scroll-mt-6`) where a section ends
   * the page or carries a top border instead. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={className ?? "mb-8 scroll-mt-6"}>
      <h2
        className={cn(
          "mb-2 text-lg font-semibold",
          icon && "flex items-center gap-1.5",
        )}
      >
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}
