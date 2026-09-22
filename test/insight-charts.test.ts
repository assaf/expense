import { describe, expect, it } from "vite-plus/test";
import { CHART_SHAPES, isChartShape, planChart } from "~/lib/insight-charts";
import type { InsightExpense, MonthBucket } from "~/lib/insights";

function exp(fields: Partial<InsightExpense>): InsightExpense {
  return {
    id: "e",
    type: "receipt",
    merchant: "",
    mileageType: "business",
    locations: [],
    description: "",
    category: "",
    report: "",
    amount: "0",
    date: "",
    hasImage: false,
    distanceMiles: "",
    imageSha256: "",
    ...fields,
  };
}

/** `count` months from January 2024, each totaling `each`. The planner reads
 * keys and totals; labels come from monthlyTotals and pass through. */
function months(count: number, each = 10): MonthBucket[] {
  const keys: string[] = [];
  let year = 2024;
  let month = 1;
  for (let i = 0; i < count; i++) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return keys.map((key) => ({ key, label: key, total: each, count: 1 }));
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

describe("isChartShape", () => {
  it("accepts the vocabulary and rejects anything else", () => {
    for (const shape of CHART_SHAPES) expect(isChartShape(shape)).toBe(true);
    expect(isChartShape("pie")).toBe(false);
    expect(isChartShape(undefined)).toBe(false);
    expect(isChartShape(3)).toBe(false);
  });
});

describe("planChart time axes", () => {
  const months36 = months(36);

  it("leaves a two-year axis month by month, with nothing to report", () => {
    const plan = planChart({
      shape: "monthly-totals",
      buckets: months(24),
      matched: [],
    });
    expect(plan.grain).toBe("month");
    expect(plan.bands).toHaveLength(24);
    expect(plan.notes).toEqual([]);
  });

  it("rolls a 36-month axis up to quarters, preserving the totals", () => {
    const plan = planChart({
      shape: "monthly-totals",
      buckets: months36,
      matched: [],
    });
    expect(plan.grain).toBe("quarter");
    expect(plan.bands).toHaveLength(12);
    expect(plan.bands[0]).toEqual({
      key: "2024-Q1",
      label: "Q1 '24",
      total: 30,
      count: 3,
    });
    expect(plan.bands.at(-1)?.key).toBe("2026-Q4");
    expect(sum(plan.bands.map((b) => b.total))).toBe(
      sum(months36.map((b) => b.total)),
    );
    // The reader is told why the chart is coarser than the question.
    expect(plan.notes).toEqual([
      "36 monthly bars would be too dense to read, so this chart shows quarters.",
    ]);
  });

  it("rolls a three-decade axis up to years", () => {
    const plan = planChart({
      shape: "cumulative",
      buckets: months(360),
      matched: [],
    });
    expect(plan.grain).toBe("year");
    expect(plan.bands[0]).toEqual({
      key: "2024",
      label: "2024",
      total: 120,
      count: 12,
    });
    expect(plan.notes).toEqual([
      "360 monthly bars would be too dense to read, so this chart shows years.",
    ]);
  });

  it("carries the grain on a stacked chart too", () => {
    const plan = planChart({
      shape: "category-trend",
      buckets: months36,
      matched: [
        exp({ category: "Software", amount: "25", date: "2024-02-10" }),
      ],
    });
    expect(plan.grain).toBe("quarter");
    // February lands in the first quarter's band, not in a month band.
    expect(plan.series[0]?.values).toEqual([
      25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });
});

describe("planChart rankings", () => {
  const rows = [
    exp({ category: "Meals", merchant: "Cafe", amount: "30" }),
    exp({ category: "Software", merchant: "Z.ai", amount: "80" }),
    exp({ category: "Meals", merchant: "Bistro", amount: "10" }),
  ];

  it("ranks a dimension and sums the rows behind each bar", () => {
    const plan = planChart({
      shape: "by-category",
      buckets: [],
      matched: rows,
    });
    expect(plan.bands.map((b) => b.label)).toEqual(["Software", "Meals"]);
    expect(plan.bands[0]).toMatchObject({ total: 80, count: 1 });
    expect(plan.bands[1]).toMatchObject({ total: 40, count: 2 });
    expect(plan.notes).toEqual([]);
  });

  it("ranks merchants for top-merchants", () => {
    const plan = planChart({
      shape: "top-merchants",
      buckets: [],
      matched: rows,
    });
    expect(plan.bands.map((b) => b.label)).toEqual(["Z.ai", "Cafe", "Bistro"]);
  });

  it("keeps the top rows and folds the tail into Other", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      exp({ category: `Category ${i + 1}`, amount: String(100 - i * 5) }),
    );
    const plan = planChart({
      shape: "by-category",
      buckets: [],
      matched: many,
    });
    expect(plan.bands).toHaveLength(8);
    expect(plan.bands.at(-1)).toMatchObject({
      label: "Other",
      total: sum(many.slice(7).map((e) => Number(e.amount))),
      count: 5,
    });
    expect(plan.notes).toEqual([
      "Showing the top 7 categories; 5 more are grouped as Other.",
    ]);
  });

  it("says how many rows the dimension had no value for", () => {
    const mixed = [
      exp({ merchant: "Z.ai", amount: "80" }),
      exp({ type: "mileage", merchant: "", amount: "9.94" }),
      exp({ type: "mileage", merchant: "", amount: "4.20" }),
    ];
    const plan = planChart({
      shape: "top-merchants",
      buckets: [],
      matched: mixed,
    });
    expect(plan.bands.map((b) => b.label)).toEqual(["Z.ai"]);
    expect(plan.notes).toEqual(["Not charted: 2 expenses with no merchant."]);
  });

  it("has nothing to draw when nothing matched", () => {
    const plan = planChart({ shape: "by-category", buckets: [], matched: [] });
    expect(plan.bands).toEqual([]);
    expect(plan.notes).toEqual([]);
  });
});

describe("planChart category trend", () => {
  const buckets = months(3);

  it("builds one series per category, aligned to the bands", () => {
    const plan = planChart({
      shape: "category-trend",
      buckets,
      matched: [
        exp({ category: "Software", amount: "20", date: "2024-01-05" }),
        exp({ category: "Software", amount: "5", date: "2024-01-20" }),
        exp({ category: "Meals", amount: "10", date: "2024-02-05" }),
      ],
    });
    expect(plan.series.map((s) => s.name)).toEqual(["Software", "Meals"]);
    expect(plan.series[0]?.values).toEqual([25, 0, 0]);
    expect(plan.series[1]?.values).toEqual([0, 10, 0]);
    expect(plan.notes).toEqual([]);
  });

  it("stacks the biggest categories and folds the rest into Other", () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      exp({
        category: `Category ${i + 1}`,
        amount: String(70 - i * 10),
        date: "2024-03-10",
      }),
    );
    const plan = planChart({
      shape: "category-trend",
      buckets,
      matched: rows,
    });
    expect(plan.series.map((s) => s.name)).toEqual([
      "Category 1",
      "Category 2",
      "Category 3",
      "Category 4",
      "Other",
    ]);
    expect(plan.series.at(-1)?.values).toEqual([0, 0, 60]);
    expect(plan.notes).toEqual([
      "Showing the top 4 categories; 3 more are grouped as Other.",
    ]);
  });

  it("says how many rows had no category", () => {
    const plan = planChart({
      shape: "category-trend",
      buckets,
      matched: [
        exp({ category: "Software", amount: "20", date: "2024-01-05" }),
        exp({ category: "", amount: "10", date: "2024-01-06" }),
      ],
    });
    expect(plan.notes).toEqual(["Not charted: 1 expense with no category."]);
  });
});
