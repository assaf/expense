import { describe, expect, it } from "vitest";
import { sortExpenses, summarizeAmounts } from "~/lib/format";
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
