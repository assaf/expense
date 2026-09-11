import { describe, expect, it } from "vitest";
import {
  filterExpenses,
  MAX_TOOL_ROWS,
  runQueryExpenses,
  type FilterableExpense,
} from "~/lib/insights-tools.server";

const expenses: FilterableExpense[] = [
  {
    id: "1",
    date: "2026-09-10",
    amount: "12.50",
    merchant: "Blue Bottle",
    category: "Meals",
    report: "",
  },
  {
    id: "2",
    date: "2026-09-10",
    amount: "30.00",
    merchant: "United Airlines",
    category: "Travel",
    report: "Q3",
  },
  {
    id: "3",
    date: "2026-09-01",
    amount: "9.99",
    merchant: "Adobe",
    category: "Software",
    report: "Q3",
  },
  {
    id: "4",
    date: "2026-08-15",
    amount: "120.00",
    type: "mileage",
    merchant: "",
    category: "Travel",
    report: "",
  },
];

const call = (args: unknown) => ({
  function: { arguments: JSON.stringify(args) },
});

describe("insights read tool (query_expenses)", () => {
  it("filters by an inclusive date range, newest first", () => {
    const rows = filterExpenses(expenses, {
      dateFrom: "2026-09-10",
      dateTo: "2026-09-10",
    });
    expect(rows.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("ANDs categories, report, merchant substring, and type", () => {
    expect(
      filterExpenses(expenses, { categories: ["Travel"], report: "Q3" }).map(
        (e) => e.id,
      ),
    ).toEqual(["2"]);
    // Substring, case-insensitive; mileage stores its addresses instead.
    expect(
      filterExpenses(expenses, { merchant: "bottle" }).map((e) => e.id),
    ).toEqual(["1"]);
    expect(
      filterExpenses(expenses, { type: "mileage" }).map((e) => e.id),
    ).toEqual(["4"]);
    // Unreported-only is the inverse of the report filter.
    expect(
      filterExpenses(expenses, { unreported: true }).map((e) => e.id),
    ).toEqual(["1", "4"]);
    // Categories are alternatives, not an AND-chain.
    expect(
      filterExpenses(expenses, { categories: ["Meals", "Software"] }).length,
    ).toBe(2);
  });

  it("reports totals for every match but caps the returned rows", () => {
    const many: FilterableExpense[] = Array.from(
      { length: MAX_TOOL_ROWS + 5 },
      (_, i) => ({
        id: String(i),
        date: "2026-09-10",
        amount: "2.00",
        merchant: `Shop ${i}`,
      }),
    );
    const payload = JSON.parse(runQueryExpenses(many, call({}))) as {
      count: number;
      total: string;
      rows: unknown[];
      truncated: boolean;
    };
    expect(payload.count).toBe(MAX_TOOL_ROWS + 5);
    expect(payload.total).toBe(((MAX_TOOL_ROWS + 5) * 2).toFixed(2));
    expect(payload.rows).toHaveLength(MAX_TOOL_ROWS);
    expect(payload.truncated).toBe(true);
  });

  it("returns an empty result set rather than throwing", () => {
    const payload = JSON.parse(
      runQueryExpenses(expenses, call({ dateFrom: "2027-01-01" })),
    ) as { count: number; rows: unknown[] };
    expect(payload.count).toBe(0);
    expect(payload.rows).toEqual([]);
  });

  it("answers malformed arguments with an error payload", () => {
    const bad = { function: { arguments: "{not json" } };
    expect(JSON.parse(runQueryExpenses(expenses, bad))).toHaveProperty("error");
    const wrong = call({ dateFrom: 42 });
    expect(JSON.parse(runQueryExpenses(expenses, wrong)).error).toBe(
      "invalid filters",
    );
  });
});
