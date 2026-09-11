import { describe, expect, it } from "vitest";
import { periodRange, withPeriodRange } from "~/lib/insight-periods";

// Wed 2026-09-10 as "today"; week starts Sunday, so this week began 09-06.
const TODAY = "2026-09-10";

describe("periodRange", () => {
  it("resolves single days", () => {
    expect(periodRange("how much did I spend today?", TODAY)).toEqual({
      after: TODAY,
      before: TODAY,
    });
    expect(periodRange("what about yesterday", TODAY)).toEqual({
      after: "2026-09-09",
      before: "2026-09-09",
    });
  });

  it("resolves weeks from Sunday", () => {
    expect(periodRange("who did I pay this week?", TODAY)).toEqual({
      after: "2026-09-06",
      before: TODAY,
    });
    expect(periodRange("what about last week", TODAY)).toEqual({
      after: "2026-08-30",
      before: "2026-09-05",
    });
  });

  it("resolves months, including the year boundary", () => {
    expect(periodRange("which reports this month?", TODAY)).toEqual({
      after: "2026-09-01",
      before: TODAY,
    });
    expect(periodRange("and last month", TODAY)).toEqual({
      after: "2026-08-01",
      before: "2026-08-31",
    });
    expect(periodRange("last month", "2026-01-15")).toEqual({
      after: "2025-12-01",
      before: "2025-12-31",
    });
  });

  it("resolves years", () => {
    expect(periodRange("everything this year", TODAY)).toEqual({
      after: "2026-01-01",
      before: TODAY,
    });
    expect(periodRange("everything last year", TODAY)).toEqual({
      after: "2025-01-01",
      before: "2025-12-31",
    });
  });

  it("resolves a named month, preferring the most recent occurrence", () => {
    expect(periodRange("what did I spend in August?", TODAY)).toEqual({
      after: "2026-08-01",
      before: "2026-08-31",
    });
    // October hasn't happened yet, so the most recent one is last year's.
    expect(periodRange("in October", TODAY)).toEqual({
      after: "2025-10-01",
      before: "2025-10-31",
    });
    expect(periodRange("in august 2024", TODAY)).toEqual({
      after: "2024-08-01",
      before: "2024-08-31",
    });
  });

  it("returns null when the question names no period", () => {
    expect(periodRange("which reports did I spend on the most?", TODAY)).toBe(
      null,
    );
    expect(periodRange("coffee", TODAY)).toBe(null);
  });
});

describe("withPeriodRange", () => {
  it("appends the range to a translated query", () => {
    expect(withPeriodRange("category:Travel", "travel this month", TODAY)).toBe(
      "category:Travel after:2026-09-01 before:2026-09-10",
    );
  });

  it("leaves a query that already carries a range alone", () => {
    const query = "merchant:united after:2026-09-03";
    expect(withPeriodRange(query, "united this month", TODAY)).toBe(query);
  });

  it("leaves a period-free question alone", () => {
    const query = "merchant:united";
    expect(withPeriodRange(query, "united", TODAY)).toBe(query);
  });
});
