import { useEffect, useState } from "react";
import { formatDateTime, formatShortDate } from "~/lib/format";

/**
 * Timestamp labels in the viewer's timezone. The server runs UTC, so a
 * date/time formatted during SSR can disagree with hydration (React logs a
 * mismatch whenever the UTC date differs from the user's local date). These
 * render the ISO string until mount, then swap in the local rendering via
 * effect: server and first client render always agree (the useToday
 * pattern, as a component).
 */

/** "Aug 4, 2026" for an ISO timestamp; the raw ISO until mounted. */
export function LocalDate({ iso }: { iso: string | null }) {
  const fallback = iso ?? "—";
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => setLocal(formatShortDate(iso)), [iso]);
  return <>{local ?? fallback}</>;
}

/** "Sep 2, 2026, 7:33 AM" for an ISO timestamp; the raw ISO until mounted. */
export function LocalDateTime({ iso }: { iso: string | null }) {
  const fallback = iso ?? "—";
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => setLocal(formatDateTime(iso)), [iso]);
  return <>{local ?? fallback}</>;
}
