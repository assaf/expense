import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isComplete,
  isReceiptComplete,
  isMileageComplete,
} from "~/lib/completeness";
import {
  formatAmount,
  parseAmount,
  normalizeAmount,
  formatDate,
  mileageMerchant,
  yearOf,
  summarizeByReport,
} from "~/lib/format";
import { recomputeMileage } from "~/lib/maps.server";
import type { ReceiptExpense, MileageExpense } from "~/lib/types";

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
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

const makeMileage = (
  overrides: Partial<MileageExpense> = {},
): MileageExpense => ({
  id: "test2",
  type: "mileage",
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
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

describe("Completeness", () => {
  it("a complete receipt is complete", () => {
    expect(isReceiptComplete(makeReceipt())).toBe(true);
  });

  it("a receipt missing merchant is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ merchant: "" }))).toBe(false);
  });

  it("a receipt with zero amount is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ amount: "0.00" }))).toBe(false);
  });

  it("a receipt missing image is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ imageFile: "" }))).toBe(false);
  });

  it("a zero-amount mileage is incomplete", () => {
    expect(isMileageComplete(makeMileage({ amount: "0.00" }))).toBe(false);
  });

  it("a complete mileage is complete", () => {
    expect(isMileageComplete(makeMileage())).toBe(true);
  });

  it("isComplete dispatches correctly", () => {
    expect(isComplete(makeReceipt())).toBe(true);
    expect(isComplete(makeMileage())).toBe(true);
    expect(isComplete(makeReceipt({ merchant: "" }))).toBe(false);
  });
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

  it("builds mileage merchant label", () => {
    expect(mileageMerchant("32.00", "0.70")).toBe("32.00 mi @ $0.70 / mi");
  });

  it("gets year from date", () => {
    expect(yearOf("2026-03-10")).toBe("2026");
    expect(yearOf("")).toBe(String(new Date().getFullYear()));
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

describe("recomputeMileage money math", () => {
  const A = { address: "A", lat: 34.05, lng: -118.2 };
  const B = { address: "B", lat: 34.06, lng: -118.1 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubOsrm(distanceMeters: number): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          routes: [
            {
              distance: distanceMeters,
              geometry: {
                coordinates: [
                  [-118.2, 34.05],
                  [-118.1, 34.06],
                ],
              },
            },
          ],
        }),
      }),
    );
  }

  it("rounds distance × rate to cents with ROUND_HALF_UP (not float toFixed)", async () => {
    // 122.15 mi × $0.70 is exactly $85.505 → $85.51. Float64 computes the
    // product a hair below .505, so .toFixed(2) yields "85.50"; decimal.js
    // keeps the exact half and rounds up.
    stubOsrm(122.15 * 1609.344);
    const r = await recomputeMileage([A, B], "0.70");
    expect(r.distanceMiles).toBe("122.15");
    expect(r.amount).toBe("85.51");
  });

  it("produces no amount when no rate is configured (not $0.00)", async () => {
    stubOsrm(10_000);
    const r = await recomputeMileage([A, B], "");
    expect(r.distanceMiles).toBe("6.21");
    expect(r.amount).toBe("");
  });

  it("produces no amount for an unparseable rate", async () => {
    stubOsrm(10_000);
    const r = await recomputeMileage([A, B], "not-a-rate");
    expect(r.amount).toBe("");
  });
});
