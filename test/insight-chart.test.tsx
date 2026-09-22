import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { InsightChart } from "~/components/InsightChart";
import type { ChartPlan } from "~/lib/insight-charts";

// The chart is the answer to a question, so what it draws has to match the
// shape the plan asked for: the wrong shape, a missing legend, a dropped
// guard note, or an unnamed chart (nothing for a screen reader to announce)
// all show up here.

function plan(overrides: Partial<ChartPlan> = {}): ChartPlan {
  return {
    shape: "monthly-totals",
    bands: [
      { key: "2026-06", label: "Jun", total: 120, count: 2 },
      { key: "2026-07", label: "Jul", total: 0, count: 0 },
    ],
    series: [],
    grain: "month",
    notes: [],
    ...overrides,
  };
}

describe("InsightChart", () => {
  it("draws one bar per band, with a baseline for an empty month", () => {
    const html = renderToStaticMarkup(<InsightChart plan={plan()} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Expense totals by month"');
    // One rounded bar, one dashed baseline, and the axis ceiling.
    expect(html.match(/<path/g)).toHaveLength(1);
    expect(html.match(/stroke-width="2"/g)).toHaveLength(1);
    expect(html).toContain("$120.00");
  });

  it("names a rolled-up axis after its grain", () => {
    const html = renderToStaticMarkup(
      <InsightChart
        plan={plan({
          shape: "cumulative",
          grain: "quarter",
          bands: [
            { key: "2026-Q1", label: "Q1 '26", total: 50, count: 1 },
            { key: "2026-Q2", label: "Q2 '26", total: 70, count: 1 },
          ],
        })}
      />,
    );
    expect(html).toContain('aria-label="Cumulative expense total by quarter"');
    // One running total per band, ending at the window's total.
    expect(html.match(/<rect/g)).toHaveLength(2);
    expect(html).toContain("$120.00");
  });

  it("stacks one series per category and names them in a legend", () => {
    const html = renderToStaticMarkup(
      <InsightChart
        plan={plan({
          shape: "category-trend",
          series: [
            { name: "Software", values: [40, 0] },
            { name: "Other", values: [0, 20] },
          ],
        })}
      />,
    );
    expect(html).toContain('aria-label="Expense categories by month"');
    expect(html.match(/<rect/g)).toHaveLength(2);
    // The legend is the only thing that says which color is which.
    expect(html).toContain("Software");
    expect(html).toContain("Other");
    expect(html).toContain("fill-sky-600");
  });

  it("ranks a dimension as labelled rows with amounts", () => {
    const html = renderToStaticMarkup(
      <InsightChart
        plan={plan({
          shape: "by-category",
          grain: undefined,
          bands: [
            { key: "Software", label: "Software", total: 80, count: 1 },
            { key: "Other", label: "Other", total: 20, count: 3 },
          ],
          notes: ["Showing the top 1 categories; 1 more are grouped as Other."],
        })}
      />,
    );
    expect(html).toContain('aria-label="Expenses by category"');
    expect(html).toContain("Software");
    expect(html).toContain("$80.00");
    expect(html).toContain("$20.00");
    // The guard's note explains why the chart is not what was asked for.
    expect(html).toContain("<figcaption");
    expect(html).toContain("grouped as Other");
  });

  it("names the merchant ranking for what it ranks", () => {
    const html = renderToStaticMarkup(
      <InsightChart
        plan={plan({
          shape: "top-merchants",
          grain: undefined,
          bands: [{ key: "Z.ai", label: "Z.ai", total: 80, count: 1 }],
        })}
      />,
    );
    expect(html).toContain('aria-label="Spend by merchant"');
    expect(html).not.toContain("<figcaption");
  });

  it("draws nothing when a ranking has nothing to rank", () => {
    const html = renderToStaticMarkup(
      <InsightChart
        plan={plan({ shape: "by-category", grain: undefined, bands: [] })}
      />,
    );
    expect(html).toBe("");
  });
});
