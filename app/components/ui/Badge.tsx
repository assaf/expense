import type { ComponentProps, ReactNode } from "react";
import { cn } from "cn";

type BadgeTone = "green" | "amber" | "blue" | "gray" | "red" | "purple";

/** Background/text pairs per tone; every entry carries its dark: variant.
 * Blue's dark background is neutral gray-700: the majority of the call
 * sites this consolidates used it (not blue-900/60). Gray carries no text
 * color: it inherits, like the category tag it backs. */
const TONE_CLASSES: Record<BadgeTone, string> = {
  green: "bg-green-100 dark:bg-green-900/60 text-green-700 dark:text-green-400",
  amber: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400",
  blue: "bg-blue-100 dark:bg-gray-700 text-blue-700 dark:text-blue-400",
  gray: "bg-gray-100 dark:bg-gray-700",
  red: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400",
  purple:
    "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300",
};

interface BadgeProps extends ComponentProps<"span"> {
  tone: BadgeTone;
  /** Square tag style (category labels, inline facts): rounded corners,
   * tighter padding, no weight bump. `tone` picks the color pair, as for
   * the pill. */
  square?: boolean;
  /** Optional leading icon (already aria-hidden by the caller). */
  icon?: ReactNode;
}

/** Small status pill: `rounded-full bg-X-100 … text-xs font-medium` with
 * its dark: variants, in one place. Extra classes (e.g. shrink-0,
 * capitalize) come through className as usual. */
export function Badge({
  tone,
  square = false,
  icon,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        square
          ? cn("rounded px-1.5 py-0.5 text-xs", TONE_CLASSES[tone])
          : cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              TONE_CLASSES[tone],
            ),
        icon && "inline-flex items-center gap-1",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}
