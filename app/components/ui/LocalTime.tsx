import { useEffect, useState } from "react";
import { formatDateTime, formatShortDate } from "~/lib/format";

/**
 * Timestamp labels in the viewer's timezone. The server runs UTC, so a
 * date/time formatted during SSR can disagree with hydration (React logs a
 * mismatch whenever the UTC date differs from the user's local date). These
 * render the ISO string until mount, then swap in the local rendering via
 * effect: server and first client render always agree (the useToday
 * pattern, as a component).
 *
 * Both wrap the text in <time> with the instant in dateTime. That attribute
 * says the same thing on the server and in the browser, so the
 * machine-readable value never mismatches: crawlers, assistive tech and the
 * pre-hydration paint all get the exact instant before the label swaps.
 */

/** "Aug 4, 2026" for an ISO timestamp; the raw ISO until mounted. */
export function LocalDate({ iso }: { iso: string | null }) {
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => setLocal(formatShortDate(iso)), [iso]);
  // Unset field: no instant to describe, so no <time> around the dash.
  if (!iso) return <>—</>;
  return <time dateTime={iso}>{local ?? iso}</time>;
}

/** "Sep 2, 2026, 7:33 AM" for an ISO timestamp; the raw ISO until mounted. */
export function LocalDateTime({ iso }: { iso: string | null }) {
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => setLocal(formatDateTime(iso)), [iso]);
  if (!iso) return <>—</>;
  return <time dateTime={iso}>{local ?? iso}</time>;
}
