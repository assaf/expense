import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "~/lib/cn";

const textareaVariants = cva(
  "rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500",
  {
    variants: {
      invalid: {
        true: "border-red-400 focus:border-red-400 focus:ring-red-400",
      },
    },
  },
);

export interface TextareaProps extends ComponentProps<"textarea"> {
  invalid?: boolean;
}

/** The shared multiline text area (rows come from the caller, e.g. rows={3}). */
export function Textarea({ className, invalid, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(textareaVariants({ invalid }), className)}
      {...props}
    />
  );
}
