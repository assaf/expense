import { describe, expect, it, vi } from "vite-plus/test";
import {
  formatAmount,
  formatDate,
  formatShortDate,
  merchantLabel,
  mileageMerchant,
  normalizeAmount,
  sortExpenses,
  summarizeAmounts,
  summarizeByReport,
  todayDate,
} from "~/lib/format";
import { exceedsMaxMoney, parseAmount } from "~/lib/money";
import type { Expense, MileageExpense, ReceiptExpense } from "~/lib/types";

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

describe("exceedsMaxMoney", () => {
  it("flags only values the numeric(10,2) columns cannot hold", () => {
    expect(exceedsMaxMoney("99999999.99")).toBe(false);
    expect(exceedsMaxMoney("100000000")).toBe(true);
    expect(exceedsMaxMoney("-100000000.01")).toBe(true);
    // Junk and empty are not "too large": the caller reports those as a
    // missing amount.
    expect(exceedsMaxMoney("")).toBe(false);
    expect(exceedsMaxMoney("coffee")).toBe(false);
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

const makeReceipt = (
  overrides: Partial<ReceiptExpense> = {},
): ReceiptExpense => ({
  id: "test1",
  type: "receipt",
  date: "2026-01-15",
  report: "2026 Test",
  category: "Testing",
  description: "",
  amount: "42.50",
  merchant: "Test Store",
  imageFile: "receipt.jpg",
  imageMime: "image/jpeg",
  originalName: "receipt.jpg",
  imageSha256: "",
  currency: "USD",
  originalAmount: "",
  fxRate: "",
  reconciledAt: "",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

const makeMileage = (
  overrides: Partial<MileageExpense> = {},
): MileageExpense => ({
  id: "test2",
  type: "mileage",
  mileageType: "business",
  date: "2026-03-10",
  report: "2026 Test",
  category: "Travel",
  description: "",
  amount: "22.40",
  locations: [
    { address: "A", lat: 34.05, lng: -118.24 },
    { address: "B", lat: 34.06, lng: -118.25 },
  ],
  distanceMiles: "32.00",
  roundTrip: true,
  route: { coords: [], returnCoords: [] },
  reconciledAt: "",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

describe("Format helpers", () => {
  it("formats amount as currency", () => {
    expect(formatAmount("42.50")).toBe("$42.50");
    expect(formatAmount("0")).toBe("$0.00");
    expect(formatAmount("")).toBe("—");
  });

  it("parseAmount parses into an exact Decimal or null", () => {
    expect(parseAmount("42.50")?.toString()).toBe("42.5");
    expect(parseAmount("0.10")?.add("0.20").toString()).toBe("0.3");
    expect(parseAmount("")).toBe(null);
    expect(parseAmount("abc")).toBe(null);
  });
  it("parseAmount rejects e-notation beyond money scale", () => {
    // toFixed renders the full digit expansion, so an unbounded exponent is
    // a heap-exhaustion DoS (11 bytes in, gigabytes allocated); the bound
    // lives at the parse, not at each entry point.
    expect(parseAmount("1e15")).not.toBe(null);
    expect(parseAmount("1e16")).toBe(null);
    expect(parseAmount("1e999999999")).toBe(null);
    expect(parseAmount("123456789012345.67")).not.toBe(null);
    expect(normalizeAmount("1e999999999")).toBe("");
  });

  it("normalizeAmount rounds to 2 decimals (exact half-up)", () => {
    expect(normalizeAmount("42.5")).toBe("42.50");
    expect(normalizeAmount("42.501")).toBe("42.50");
    expect(normalizeAmount("1.005")).toBe("1.01");
    expect(normalizeAmount("42.995")).toBe("43.00");
    expect(normalizeAmount("")).toBe("");
  });

  it("formats dates", () => {
    expect(formatDate("2026-01-15")).toContain("Jan");
    expect(formatDate("")).toBe("—");
  });

  it("formats date-only strings as calendar dates", () => {
    // A UTC-midnight parse renders Jan 1 as Dec 31 west of Greenwich.
    expect(formatShortDate("2026-01-01")).toBe("Jan 1, 2026");
  });

  it("builds mileage merchant label", () => {
    expect(mileageMerchant("32.00", "0.70")).toBe("32.00 mi @ $0.70 / mi");
    // No rate configured for the year, but the distance still shows.
    expect(mileageMerchant("32.00", "")).toBe("32.00 mi");
    expect(mileageMerchant("", "0.70")).toBe("");
  });

  it("prefixes the merchant label with the mileage type", () => {
    const rates = [
      {
        type: "business" as const,
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        rate: "0.725",
      },
    ];
    expect(merchantLabel(makeMileage({ date: "2026-03-10" }), rates)).toBe(
      "Business · 32.00 mi @ $0.725 / mi",
    );
    // A trip without a distance shows just the type.
    expect(
      merchantLabel(
        makeMileage({ date: "2026-03-10", distanceMiles: "" }),
        rates,
      ),
    ).toBe("Business");
  });

  it("summarizes expenses per report with exact totals", () => {
    const summary = summarizeByReport([
      makeReceipt({ report: "A", amount: "10.00" }),
      makeReceipt({ report: "A", amount: "5.50" }),
      makeReceipt({ report: "", amount: "3.00" }),
      makeReceipt({ report: "B", amount: "" }),
    ]);
    expect(summary.get("A")?.count).toBe(2);
    expect(summary.get("A")?.total.toString()).toBe("15.5");
    expect(summary.get("B")?.count).toBe(1);
    expect(summary.get("B")?.total.isZero()).toBe(true);
    // Expenses without a report are skipped unless the bucket is requested.
    expect(summary.has("Unassigned")).toBe(false);
  });

  it("summarizeByReport can bucket unassigned expenses", () => {
    const summary = summarizeByReport(
      [makeReceipt({ report: "", amount: "3.00" })],
      { includeUnassigned: true },
    );
    expect(summary.get("Unassigned")?.total.toString()).toBe("3");
  });

  it("report totals don't drift on repeated float-unfriendly additions", () => {
    // 0.1 + 0.2 in float64 is 0.30000000000000004; 100 × $0.10 sums to
    // 9.99999999999998. Decimal addition stays exact.
    const expenses = Array.from({ length: 100 }, (_, i) =>
      makeReceipt({ report: "A", amount: "0.10", id: `r${i}` }),
    );
    const total = summarizeByReport(expenses).get("A")!.total;
    expect(total.toString()).toBe("10");
    expect(formatAmount(total)).toBe("$10.00");
  });

  it("formatAmount accepts a Decimal directly", () => {
    expect(formatAmount(parseAmount("0.10")!.add("0.20"))).toBe("$0.30");
  });
});
