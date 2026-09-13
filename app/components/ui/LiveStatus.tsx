import type { ReactNode } from "react";

/**
 * Screen-reader-only live region for transient status text: drop hints, save
 * notes, "Added <name>" confirmations. One definition keeps the role/aria
 * pairing in a single place, since that pairing is what makes the
 * announcement happen at all.
 */
export function LiveStatus({ children }: { children: ReactNode }) {
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {children}
    </div>
  );
}
