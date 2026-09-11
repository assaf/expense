import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpenseTable } from "~/routes/insights";
import type { InsightExpense } from "~/lib/insights";

// The chart answers the question; the rows are the evidence behind it, so
// the table starts collapsed behind a disclosure button. A regression that
// defaults it open (or drops the toggle) shows up here.
function row(overrides: Partial<InsightExpense> = {}): InsightExpense {
  return {
    id: "e1",
    type: "receipt",
    date: "2026-09-10",
    merchant: "Blue Bottle",
    mileageType: "business",
    locations: [],
    description: "coffee",
    category: "Meals",
    amount: "12.50",
    report: "2026 Business",
    ...overrides,
  };
}

describe("ExpenseTable disclosure", () => {
  it("renders collapsed, with a labelled toggle and no rows", () => {
    const html = renderToStaticMarkup(
      <ExpenseTable expenses={[row(), row({ id: "e2" })]} />,
    );
    expect(html).not.toContain("<table");
    expect(html).toContain("Show");
    expect(html).toContain("2 expenses");
    // A real disclosure: the button reports its state to assistive tech.
    expect(html).toContain('aria-expanded="false"');
  });

  it("labels a single row in the singular", () => {
    expect(renderToStaticMarkup(<ExpenseTable expenses={[row()]} />)).toContain(
      "1 expense",
    );
  });
});
