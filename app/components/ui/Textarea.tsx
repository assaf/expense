import type { ComponentProps } from "react";
import { inputVariants } from "~/components/ui/Input";
import { cn } from "~/lib/cn";

interface TextareaProps extends ComponentProps<"textarea"> {
  invalid?: boolean;
}

/** The shared multiline text area (rows come from the caller, e.g. rows={3}). */
export function Textarea({ className, invalid, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(inputVariants({ invalid }), className)}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
}
