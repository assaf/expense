import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "~/lib/cn";

export const inputVariants = cva(
  "rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:focus:border-blue-400 dark:focus:ring-blue-400",
  {
    variants: {
      invalid: {
        true: "border-red-400 focus:border-red-400 focus:ring-red-400",
      },
    },
  },
);

interface InputProps extends ComponentProps<"input"> {
  /** Red border + red focus ring — pair with an inline error message. */
  invalid?: boolean;
}

/** The shared text/number/date/email input used by every form. Width is
 * left to the caller (grid/flex stretch, or a class like `w-24`). */
export function Input({ className, invalid, ...props }: InputProps) {
  return (
    <input
      className={cn(inputVariants({ invalid }), className)}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
}
