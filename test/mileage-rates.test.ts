import { describe, it, expect } from "vitest";
import {
  currentMileageRates,
  formatRate,
  mileageAmount,
  mileageRateFor,
  isMileageType,
} from "~/lib/mileage-rates";

describe("mileage rates (master table helpers)", () => {
  const rates = [
    {
      type: "business" as const,
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      rate: "0.76",
    },
    {
      type: "business" as const,
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      rate: "0.725",
    },
    {
      type: "business" as const,
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      rate: "0.70",
    },
    {
      type: "charity" as const,
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      rate: "0.14",
    },
    {
      type: "charity" as const,
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      rate: "0.14",
    },
    {
      type: "medical" as const,
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      rate: "0.235",
    },
    {
      type: "medical" as const,
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      rate: "0.205",
    },
    {
      type: "moving" as const,
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      rate: "0.235",
    },
  ];

  it("picks the rate for the trip's date and type", () => {
    expect(mileageRateFor(rates, "2026-08-15", "business")).toBe("0.76");
    expect(mileageRateFor(rates, "2026-03-15", "business")).toBe("0.725");
    expect(mileageRateFor(rates, "2025-06-01", "business")).toBe("0.70");
    expect(mileageRateFor(rates, "2026-08-15", "charity")).toBe("0.14");
    expect(mileageRateFor(rates, "2026-08-15", "medical")).toBe("0.235");
    expect(mileageRateFor(rates, "2026-03-15", "medical")).toBe("0.205");
    expect(mileageRateFor(rates, "2026-08-15", "moving")).toBe("0.235");
  });

  it("returns no rate outside any period (never a guess)", () => {
    expect(mileageRateFor(rates, "2010-06-01", "business")).toBe("");
    expect(mileageRateFor(rates, "2027-01-01", "business")).toBe("");
    // Period boundaries are inclusive.
    expect(mileageRateFor(rates, "2026-07-01", "business")).toBe("0.76");
    expect(mileageRateFor(rates, "2026-06-30", "business")).toBe("0.725");
  });

  it("currentMileageRates returns the covering period and all four types", () => {
    const current = currentMileageRates(rates, "2026-08-15")!;
    expect(current.isCurrent).toBe(true);
    expect(current.startDate).toBe("2026-07-01");
    expect(current.endDate).toBe("2026-12-31");
    expect(current.byType).toEqual({
      business: "0.76",
      charity: "0.14",
      medical: "0.235",
      moving: "0.235",
    });
  });

  it("currentMileageRates falls back to the latest period when none covers", () => {
    const fallback = currentMileageRates(rates, "2027-01-01")!;
    expect(fallback.isCurrent).toBe(false);
    expect(fallback.startDate).toBe("2026-07-01");
    expect(fallback.byType.business).toBe("0.76");
    expect(currentMileageRates([], "2026-08-15")).toBeNull();
  });

  it("multiplies distance × rate with exact half-up rounding", () => {
    // 122.15 × 0.70 = 85.505 → 85.51 (half rounds up).
    expect(mileageAmount("122.15", "0.70")).toBe("85.51");
    // 122.15 × 0.235 = 28.70525 → 28.71.
    expect(mileageAmount("122.15", "0.235")).toBe("28.71");
    expect(mileageAmount("10.00", "0.76")).toBe("7.60");
    expect(mileageAmount("10.00", "0.725")).toBe("7.25");
    expect(mileageAmount("10.00", "0.14")).toBe("1.40");
    expect(mileageAmount("0.01", "0.70")).toBe("0.01");
  });

  it("produces no amount without a distance or rate", () => {
    expect(mileageAmount("", "0.70")).toBe("");
    expect(mileageAmount("10.00", "")).toBe("");
    expect(mileageAmount("0", "0.70")).toBe("");
    expect(mileageAmount("abc", "0.70")).toBe("");
    expect(mileageAmount("10.00", "junk")).toBe("");
  });

  it("formats rates for display without rounding away a half cent", () => {
    expect(formatRate("0.76")).toBe("0.76");
    expect(formatRate("0.70")).toBe("0.70");
    expect(formatRate("0.725")).toBe("0.725");
    expect(formatRate("0.235")).toBe("0.235");
    expect(formatRate("0.760")).toBe("0.76");
    expect(formatRate("0.7")).toBe("0.70");
  });

  it("isMileageType accepts the four IRS types and rejects everything else", () => {
    expect(isMileageType("business")).toBe(true);
    expect(isMileageType("charity")).toBe(true);
    expect(isMileageType("medical")).toBe(true);
    expect(isMileageType("moving")).toBe(true);
    expect(isMileageType("personal")).toBe(false);
    expect(isMileageType("")).toBe(false);
    expect(isMileageType(42)).toBe(false);
    expect(isMileageType(null)).toBe(false);
    expect(isMileageType(undefined)).toBe(false);
  });
});
