import type { ComponentProps } from "react";
import { cn } from "~/lib/cn";

const variants = {
  default:
    "rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800",
  dashed:
    "rounded-xl border border-dashed border-gray-300 dark:border-gray-600",
  green:
    "rounded-xl border border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/50",
  amber:
    "rounded-xl border border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/50",
  blue: "rounded-xl border border-blue-200 bg-blue-50/50 dark:border-gray-600 dark:bg-blue-900/50",
};

type CardVariant = keyof typeof variants;

interface CardProps extends ComponentProps<"div"> {
  variant?: CardVariant;
}

export function Card({
  variant = "default",
  className,
  children,
  ...props
}: CardProps) {
  return (
    <div className={cn(variants[variant], className)} {...props}>
      {children}
    </div>
  );
}
