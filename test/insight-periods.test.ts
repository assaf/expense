import { describe, expect, it } from "vitest";
import {
  periodRange,
  periodScope,
  withPeriodRange,
} from "~/lib/insight-periods";

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

  it("resolves rolling windows, inclusive of today", () => {
    // "last 30 days" asked on 2026-09-10 starts 2026-08-12 (30 days inclusive).
    expect(
      periodRange(
        "which reports did I spend most on in the last 30 days?",
        TODAY,
      ),
    ).toEqual({
      after: "2026-08-12",
      before: TODAY,
    });
    expect(periodRange("past 7 days", TODAY)).toEqual({
      after: "2026-09-04",
      before: TODAY,
    });
    expect(periodRange("spending over the last 2 weeks", TODAY)).toEqual({
      after: "2026-08-28",
      before: TODAY,
    });
    expect(periodRange("previous 3 months", TODAY)).toEqual({
      after: "2026-06-01",
      before: TODAY,
    });
  });

  it("resolves quarters and year-to-date", () => {
    expect(periodRange("what about this quarter?", TODAY)).toEqual({
      after: "2026-07-01",
      before: TODAY,
    });
    expect(periodRange("and last quarter?", TODAY)).toEqual({
      after: "2026-04-01",
      before: "2026-06-30",
    });
    expect(periodRange("spending in Q2 2026", TODAY)).toEqual({
      after: "2026-04-01",
      before: "2026-06-30",
    });
    expect(periodRange("how am I doing so far?", TODAY)).toEqual({
      after: "2026-01-01",
      before: TODAY,
    });
  });

  it("resolves dates the user typed themselves", () => {
    expect(periodRange("from 2026-08-01 to 2026-08-31", TODAY)).toEqual({
      after: "2026-08-01",
      before: "2026-08-31",
    });
    // A half-open bound pairs with today.
    expect(periodRange("since 2026-08-15", TODAY)).toEqual({
      after: "2026-08-15",
      before: TODAY,
    });
    expect(periodRange("everything until 2026-07-01", TODAY)).toEqual({
      after: "2026-01-01",
      before: "2026-07-01",
    });
  });

  it("returns null when the question names no period", () => {
    expect(periodRange("which reports did I spend on the most?", TODAY)).toBe(
      null,
    );
    expect(periodRange("coffee", TODAY)).toBe(null);
  });
});

describe("periodScope (chart decision)", () => {
  const charts = (q: string) => periodScope(q, TODAY)?.chart;

  it("does not chart windows inside one calendar month", () => {
    for (const q of [
      "how much today?",
      "yesterday?",
      "this week",
      "last week",
      "the last 30 days",
      "past 2 weeks",
      "this month",
      "last month",
      "in August",
    ]) {
      expect(`${q}: ${charts(q)}`).toBe(`${q}: false`);
    }
  });

  it("charts multi-month windows, where a trend exists", () => {
    for (const q of [
      "this quarter",
      "last quarter",
      "Q2 2026",
      "this year",
      "last year",
      "how am I doing so far?",
      "the last 3 months",
      "from 2026-06-01 to 2026-08-31",
    ]) {
      expect(`${q}: ${charts(q)}`).toBe(`${q}: true`);
    }
  });

  it("spans the chart window over the range's own months", () => {
    expect(periodScope("this quarter", TODAY)?.months).toBe(3);
    expect(periodScope("last quarter", TODAY)?.months).toBe(3);
    expect(periodScope("this year", TODAY)?.months).toBe(9);
    expect(periodScope("last 30 days", TODAY)?.months).toBe(2);
    expect(periodScope("today", TODAY)?.months).toBe(1);
    // A decade-long explicit range still renders (clamped, not unbounded).
    expect(periodScope("from 2016-01-01 to 2026-09-10", TODAY)?.months).toBe(
      60,
    );
  });

  it("leaves the model's choice alone when no period is named", () => {
    expect(periodScope("which merchants cost the most?", TODAY)).toBe(null);
  });
});

describe("withPeriodRange", () => {
  it("appends the range to a translated query", () => {
    expect(withPeriodRange("category:Travel", "travel this month", TODAY)).toBe(
      "category:Travel after:2026-09-01 before:2026-09-10",
    );
  });

  it("replaces a range the model invented instead of merging it", () => {
    // The model guessed a year range for a month question: the app's range
    // is authoritative, so the wrong one must not survive.
    expect(
      withPeriodRange(
        "category:Travel after:2020-01-01 before:2026-12-31",
        "travel this month?",
        TODAY,
      ),
    ).toBe("category:Travel after:2026-09-01 before:2026-09-10");
  });

  it("leaves a query that already carries a range alone", () => {
    const query = "merchant:united after:2026-09-03";
    expect(withPeriodRange(query, "united", TODAY)).toBe(query);
  });

  it("leaves a period-free question alone", () => {
    const query = "merchant:united";
    expect(withPeriodRange(query, "united", TODAY)).toBe(query);
  });
});
