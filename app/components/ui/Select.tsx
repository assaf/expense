import type { ComponentProps } from "react";
import { cn } from "~/lib/cn";

/** The shared dropdown. Keeps Tailwind Forms' chevron styling. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500",
        className,
      )}
      {...props}
    />
  );
}
