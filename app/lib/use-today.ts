import { useEffect, useState } from "react";

import { todayDate } from "~/lib/format";

/** Browser-local today (YYYY-MM-DD), or null until mounted. The server
 * runs UTC and must not guess the user's day, so anything date-dependent
 * (badges, rate tips) computes client-side after mount. */
export function useToday(): string | null {
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    setToday(todayDate());
  }, []);
  return today;
}
