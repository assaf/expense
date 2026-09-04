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
        "p-12 text-center text-gray-500 dark:text-gray-400",
        className,
      )}
      role="status"
    >
      {children}
    </Card>
  );
}
