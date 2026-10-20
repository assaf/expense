import type { ReactNode } from "react";
import { Card } from "~/components/ui/Card";
import { cn } from "cn";

interface EmptyStateProps {
  children: ReactNode;
  className?: string;
}

export function EmptyState({ children, className }: EmptyStateProps) {
  return (
    <Card
      variant="dashed"
      className={cn(
        // gray-600, not gray-500: on the page canvas (and on a white card)
        // gray-500 lands at 3.4:1, under the 4.5:1 body-text floor, and this
        // card is the first thing a new account reads.
        "p-12 text-center text-gray-600 dark:text-gray-300",
        className,
      )}
      role="status"
    >
      {children}
    </Card>
  );
}
