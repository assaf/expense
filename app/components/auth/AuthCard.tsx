import type { ReactNode } from "react";
import { Card } from "~/components/ui/Card";
import { cn } from "~/lib/cn";

interface AuthCardProps {
  /** Center the card's text, for icon-tile screens whose copy centers
   * itself (check-your-email, verification results). */
  center?: boolean;
  children: ReactNode;
}

/** The shared public auth screen: a full-screen centered page holding the
 * narrow auth card. Compose with `AuthTile` for the dark logo tile, then
 * supply the title/copy/form as children. */
export function AuthCard({ center, children }: AuthCardProps) {
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center bg-gray-50 dark:bg-gray-900 px-4"
    >
      <Card
        className={cn("w-full max-w-sm p-8 shadow-sm", center && "text-center")}
      >
        {children}
      </Card>
    </main>
  );
}

/** The centered header block of an auth card: logo tile, title, blurb,
 * and an optional note line (a step counter, a re-connect reminder).
 * `icon` is the whole tile, so consent pages can use their own colors. */
export function AuthHeader({
  icon,
  title,
  blurb,
  note,
}: {
  icon: ReactNode;
  title: ReactNode;
  blurb?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col items-center gap-2 text-center">
      {icon}
      <h1 className="text-xl font-bold">{title}</h1>
      {blurb ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{blurb}</p>
      ) : null}
      {note ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">{note}</p>
      ) : null}
    </div>
  );
}

/** The dark rounded logo tile at the top of an auth card. */
export function AuthTile({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gray-900">
      {children}
    </div>
  );
}
