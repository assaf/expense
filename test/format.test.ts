import { describe, expect, it, vi } from "vitest";
import { sortExpenses, summarizeAmounts, todayDate } from "~/lib/format";
import type { Expense } from "~/lib/types";

function receipt(id: string, date: string, createdAt: string): Expense {
  return {
    id,
    type: "receipt",
    date,
    report: "",
    category: "",
    description: "",
    amount: null,
    merchant: "X",
    imageFile: "",
    imageMime: "",
    originalName: "",
    locations: [],
    createdAt,
    updatedAt: createdAt,
  } as unknown as Expense;
}

describe("sortExpenses", () => {
  it("orders same-day expenses by when they were recorded (newest first)", () => {
    const sorted = sortExpenses([
      receipt("a", "2026-08-20", "2026-08-20T09:00:00.000Z"),
      receipt("b", "2026-08-20", "2026-08-20T18:30:00.000Z"),
      receipt("c", "2026-08-19", "2026-08-20T23:00:00.000Z"),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["b", "a", "c"]);
  });

  it("orders same-day expenses oldest-recorded first when asc", () => {
    const sorted = sortExpenses(
      [
        receipt("a", "2026-08-20", "2026-08-20T18:30:00.000Z"),
        receipt("b", "2026-08-20", "2026-08-20T09:00:00.000Z"),
      ],
      false,
    );
    expect(sorted.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("still sorts undated expenses last", () => {
    const sorted = sortExpenses([
      receipt("undated", "", "2026-01-01T00:00:00.000Z"),
      receipt("dated", "2026-08-20", "2026-08-20T09:00:00.000Z"),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["dated", "undated"]);
  });
});

describe("summarizeAmounts", () => {
  it("sums amounts with exact decimal math", () => {
    const { count, total } = summarizeAmounts([
      { amount: "0.10" },
      { amount: "0.20" },
    ]);
    expect(count).toBe(2);
    // 0.1 + 0.2 in float64 is 0.30000000000000004; decimals say 0.3.
    expect(total.toFixed(2)).toBe("0.30");
  });

  it("counts empty-amount rows but leaves them out of the total", () => {
    const { count, total } = summarizeAmounts([
      { amount: "12.34" },
      { amount: "" },
      { amount: "1.00" },
    ]);
    expect(count).toBe(3);
    expect(total.toFixed(2)).toBe("13.34");
  });

  it("returns zero for no rows", () => {
    const { count, total } = summarizeAmounts([]);
    expect(count).toBe(0);
    expect(total.toFixed(2)).toBe("0.00");
  });
});

/** todayDate is the logic behind useToday (the client-side "today" that
 * keeps date math out of UTC-running server code). The expected value
 * comes from Intl (en-CA yields YYYY-MM-DD) in the process's real
 * timezone, an independent oracle: any drift between the offset-shift
 * implementation and the platform's own local-date computation fails, at
 * every host timezone. The suite's pinned clock covers the first check;
 * the boundary cases move the clock with vitest fake timers. */
describe("todayDate (the contract behind useToday)", () => {
  const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localDate = (ms: number): string =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));

  it("returns the local YYYY-MM-DD for the pinned instant", () => {
    expect(todayDate()).toBe(localDate(Date.now()));
  });

  it("agrees with the platform local date across day, month, and year edges", () => {
    // Instants near local midnight and calendar edges for most timezones;
    // whatever the host TZ, implementation and oracle must agree.
    const instants = [
      Date.UTC(2026, 6, 15, 0, 30), // 00:30 UTC
      Date.UTC(2026, 6, 15, 23, 30), // 23:30 UTC
      Date.UTC(2026, 6, 31, 12, 0), // month boundary mid-day
      Date.UTC(2026, 11, 31, 23, 15), // year boundary, late UTC
      Date.UTC(2026, 0, 1, 0, 15), // year boundary, early UTC
    ];
    for (const now of instants) {
      vi.useFakeTimers({ now });
      try {
        expect(todayDate()).toBe(localDate(now));
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
