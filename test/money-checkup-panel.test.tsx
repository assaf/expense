import { MemoryRouter } from "react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { MoneyCheckup } from "~/components/MoneyCheckup";
import type { InsightExpense } from "~/lib/insights";
import { NOTHING_OUTSTANDING, moneyCheckup } from "~/lib/money-checkup";

/** A tidy receipt in the window: the panel's findings come from the fields
 * a test spells out. */
function row(fields: Partial<InsightExpense> = {}): InsightExpense {
  return {
    id: "e1",
    type: "receipt",
    merchant: "",
    mileageType: "business",
    locations: [],
    description: "",
    category: "Software",
    report: "2026",
    amount: "10.00",
    date: "2026-03-01",
    hasImage: true,
    distanceMiles: "",
    imageSha256: "",
    ...fields,
  };
}

function render(expenses: InsightExpense[]): string {
  // The panel links to rows, and a link needs a router: a panel rendered
  // outside one would fail here, not in the browser.
  return renderToStaticMarkup(
    <MemoryRouter>
      <MoneyCheckup checkup={moneyCheckup({ expenses, today: "2026-07-15" })} />
    </MemoryRouter>,
  );
}

describe("MoneyCheckup panel", () => {
  const messy: InsightExpense[] = [
    row({
      id: "a",
      date: "2026-02-01",
      amount: "10.00",
      category: "",
      merchant: "OfficeMax",
    }),
    row({
      id: "b",
      date: "2026-05-01",
      amount: "20.00",
      category: "",
      report: "",
      merchant: "Alaska Airlines",
    }),
  ];

  it("heads the panel with the window and the year so far", () => {
    const html = render(messy);
    expect(html).toContain("Money checkup");
    expect(html).toContain("Jan 1, 2026 - Jul 15, 2026");
    expect(html).toContain("$30.00 across 2 expenses this year.");
    expect(html).toContain("At this rate: about $55.87 by December 31");
  });

  it("lists each finding with its rows and the page that fixes it", () => {
    const html = render(messy);
    expect(html).toContain("2 expenses worth $30.00 with no category");
    expect(html).toContain('href="/expense/a"');
    expect(html).toContain('href="/expense/b"');
    // The link text names the row and its amount (newest first).
    expect(html).toContain("Alaska Airlines · $20.00");
    expect(html).toContain("1 expense worth $20.00 in no report");
    expect(html).toContain('href="/export"');
    expect(html).toContain("Open reports");
  });

  it("says a clean year is clean, with no list at all", () => {
    const html = render([row({ id: "a" })]);
    expect(html).toContain(NOTHING_OUTSTANDING);
    expect(html).not.toContain("<ul");
  });
});
