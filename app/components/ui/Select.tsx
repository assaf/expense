import type { ComponentProps } from "react";
import { inputVariants } from "~/components/ui/Input";
import { cn } from "~/lib/cn";

/** The shared dropdown. Keeps Tailwind Forms' chevron styling. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(inputVariants(), className)} {...props} />;
}
