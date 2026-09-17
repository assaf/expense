import { countLabel } from "~/lib/format";
import type { InsightExpense, MonthBucket } from "~/lib/insights";

/**
 * The insights chart vocabulary, and the guard that keeps a chart readable.
 *
 * The translator picks a SHAPE from a closed set; the app computes the
 * numbers from the user's real expenses; this module decides whether those
 * numbers can be drawn at all. A chart nobody can read is worse than a
 * coarse one, so the guard rolls a long month axis up (to quarters, then to
 * years), caps a stacked or ranked list (the biggest rows plus "Other"),
 * and reports every change as a note under the chart: the reader asked a
 * question the picture alone would misanswer.
 *
 * Pure and isomorphic: the route re-plans each exchange in the browser from
 * the snapshot it already has, so a chart costs no request and no render
 * service.
 */

/** The charts the app can draw. Closed on purpose: the prompt spells the
 * list out for the model, and anything else is repaired to the default the
 * same way an unusable filter falls back to "everything". */
export const CHART_SHAPES = [
  /** Bars: what was spent in each month (or quarter, or year) of the
   * window. The default, and the answer to "how much did I spend". */
  "monthly-totals",
  /** Line: the running total across the window ("am I on pace?"). */
  "cumulative",
  /** Stacked bars: the category mix per band ("what's driving it?"). */
  "category-trend",
  /** Ranked bars: totals per category over the whole window. */
  "by-category",
  /** Ranked bars: totals per merchant over the whole window. */
  "top-merchants",
] as const;

export type ChartShape = (typeof CHART_SHAPES)[number];

/** What every earlier build drew, and what an unknown shape is repaired
 * to: a chart with the wrong shape still answers the question, roughly. */
export const DEFAULT_CHART_SHAPE: ChartShape = "monthly-totals";

/** Whether a value is one of the shapes this build can render. The model's
 * answer and the stored exchange are both untrusted, so both are checked. */
export function isChartShape(value: unknown): value is ChartShape {
  return (CHART_SHAPES as readonly unknown[]).includes(value);
}

/** The ranked shapes: the axis is a name, not a date. */
const RANK_SHAPES: ReadonlySet<ChartShape> = new Set([
  "by-category",
  "top-merchants",
]);

/** One band on a chart's axis: a month, a quarter, a year, or a ranked name
 * (a category, a merchant). Structurally a MonthBucket, so a month axis
 * passes straight through when nothing needs rolling up. */
export interface ChartBand {
  key: string;
  label: string;
  total: number;
  count: number;
}

/** One stacked series (`category-trend`): its name, and one value per band,
 * aligned by index. */
export interface ChartSeries {
  name: string;
  values: number[];
}

/** How coarse a time axis is: "month" unless the window is too long to read
 * a bar at a time. Not exported: consumers read the plan's `grain`. */
type ChartGrain = "month" | "quarter" | "year";

/** The data behind one rendered chart, in the shape the SVG needs. */
export interface ChartPlan {
  shape: ChartShape;
  /** The axis: oldest first on a time chart, largest first on a ranking. */
  bands: ChartBand[];
  /** Stacked series, aligned to `bands`; empty for every other shape. */
  series: ChartSeries[];
  /** The grain `bands` are drawn at. Absent on the ranked shapes, whose
   * axis is not time. */
  grain?: ChartGrain;
  /** What the guard had to do to keep this readable, for under the chart. */
  notes: string[];
}

/** Bands a time axis carries before the bars are too thin to read: 24
 * months is two years at 25 units of the 600-unit viewBox. */
const MAX_TIME_BANDS = 24;

/** Ranked rows per chart, "Other" included: past eight, the labels are the
 * chart and a table is the honest rendering. */
const MAX_RANK_BANDS = 8;

/** Stacked series per chart, "Other" included. Past five, the legend is
 * the chart. */
const MAX_SERIES = 5;

/** The band that collects everything the guard could not show. */
const OTHER = "Other";

/** Plural noun per ranked dimension, for the guard's note. */
const DIMENSION_PLURAL = {
  category: "categories",
  merchant: "merchants",
} as const;

type RankDimension = keyof typeof DIMENSION_PLURAL;

/** Plan one exchange's chart: the shape the model picked, the window's
 * monthly buckets, and the rows behind them. Everything the renderer needs,
 * plus what the guard changed to keep it readable. */
export function planChart(input: {
  shape: ChartShape;
  buckets: MonthBucket[];
  matched: readonly InsightExpense[];
}): ChartPlan {
  const { shape, buckets, matched } = input;
  if (RANK_SHAPES.has(shape)) {
    const dimension: RankDimension =
      shape === "by-category" ? "category" : "merchant";
    const ranked = rankBands(matched, dimension);
    return { shape, bands: ranked.bands, series: [], notes: ranked.notes };
  }
  const axis = rollUp(buckets);
  if (shape === "category-trend") {
    const trend = trendSeries(matched, axis.bands, axis.grain);
    return {
      shape,
      bands: axis.bands,
      series: trend.series,
      grain: axis.grain,
      notes: [...axis.notes, ...trend.notes],
    };
  }
  return {
    shape,
    bands: axis.bands,
    series: [],
    grain: axis.grain,
    notes: axis.notes,
  };
}

/** Fit a month axis to the chart: quarters past two years, years past two
 * decades, so an all-time window draws readable bars instead of sixty
 * hairlines. Totals are preserved, and the change is always reported. */
function rollUp(buckets: MonthBucket[]): {
  bands: ChartBand[];
  grain: ChartGrain;
  notes: string[];
} {
  if (buckets.length <= MAX_TIME_BANDS) {
    return { bands: buckets, grain: "month", notes: [] };
  }
  const quarters = groupBands(buckets, quarterOf);
  if (quarters.length <= MAX_TIME_BANDS) {
    return {
      bands: quarters,
      grain: "quarter",
      notes: [tooDense(buckets.length, "quarters")],
    };
  }
  return {
    bands: groupBands(buckets, yearOf),
    grain: "year",
    notes: [tooDense(buckets.length, "years")],
  };
}

/** The guard's note for a rolled-up axis. `buckets` is the month count the
 * model's window asked for, `grain` what the chart shows instead. */
function tooDense(months: number, grain: "quarters" | "years"): string {
  return `${months} monthly bars would be too dense to read, so this chart shows ${grain}.`;
}

/** Sum month buckets into coarser bands, keeping the axis order. */
function groupBands(
  buckets: MonthBucket[],
  group: (key: string) => { key: string; label: string },
): ChartBand[] {
  const byKey = new Map<string, ChartBand>();
  const bands: ChartBand[] = [];
  for (const b of buckets) {
    const target = group(b.key);
    let band = byKey.get(target.key);
    if (!band) {
      band = { key: target.key, label: target.label, total: 0, count: 0 };
      byKey.set(target.key, band);
      bands.push(band);
    }
    band.total += b.total;
    band.count += b.count;
  }
  return bands;
}

/** "2026-07" → Q3 '26. A quarter label always carries its year: Q1 alone
 * appears once per year on the axis. */
function quarterOf(key: string): { key: string; label: string } {
  const month = Number(key.slice(5, 7));
  const quarter = Math.floor((month - 1) / 3) + 1;
  return {
    key: `${key.slice(0, 4)}-Q${quarter}`,
    label: `Q${quarter} '${key.slice(2, 4)}`,
  };
}

/** "2026-07" → 2026. */
function yearOf(key: string): { key: string; label: string } {
  return { key: key.slice(0, 4), label: key.slice(0, 4) };
}

/** The band key a date falls in at this grain, so a stacked series lines up
 * with a rolled-up axis. */
function bandKeyer(grain: ChartGrain): (date: string) => string {
  if (grain === "month") return (date) => date.slice(0, 7);
  if (grain === "quarter") return (date) => quarterOf(date.slice(0, 7)).key;
  return (date) => date.slice(0, 4);
}

/** Rank the matched rows by one dimension, largest first, keeping the top
 * rows and folding the rest into "Other". Rows without a value for the
 * dimension are counted in a note rather than drawn as a nameless band. */
function rankBands(
  matched: readonly InsightExpense[],
  dimension: RankDimension,
): { bands: ChartBand[]; notes: string[] } {
  const totals = new Map<string, ChartBand>();
  let skipped = 0;
  for (const e of matched) {
    const name = (dimension === "category" ? e.category : e.merchant).trim();
    if (!name) {
      skipped += 1;
      continue;
    }
    const band = totals.get(name) ?? {
      key: name,
      label: name,
      total: 0,
      count: 0,
    };
    band.total += Number(e.amount) || 0;
    band.count += 1;
    totals.set(name, band);
  }
  const ranked = [...totals.values()].toSorted(
    (a, b) => b.total - a.total || a.label.localeCompare(b.label),
  );
  const notes: string[] = [];
  let bands = ranked;
  if (ranked.length > MAX_RANK_BANDS) {
    const rest = ranked.slice(MAX_RANK_BANDS - 1);
    bands = [
      ...ranked.slice(0, MAX_RANK_BANDS - 1),
      {
        key: OTHER,
        label: OTHER,
        total: rest.reduce((sum, b) => sum + b.total, 0),
        count: rest.reduce((sum, b) => sum + b.count, 0),
      },
    ];
    notes.push(
      `Showing the top ${MAX_RANK_BANDS - 1} ${DIMENSION_PLURAL[dimension]}; ${rest.length} more are grouped as Other.`,
    );
  }
  if (skipped > 0) {
    notes.push(notCharted(skipped, `no ${dimension}`));
  }
  return { bands, notes };
}

/** One stacked series per category, biggest first, folded into "Other" past
 * MAX_SERIES: a twenty-category stack is a color legend, not a chart. */
function trendSeries(
  matched: readonly InsightExpense[],
  bands: ChartBand[],
  grain: ChartGrain,
): { series: ChartSeries[]; notes: string[] } {
  const index = new Map(bands.map((b, i) => [b.key, i]));
  const keyOf = bandKeyer(grain);
  const totals = new Map<string, number>();
  const values = new Map<string, number[]>();
  let skipped = 0;
  for (const e of matched) {
    const name = e.category.trim();
    if (!name) {
      skipped += 1;
      continue;
    }
    const band = index.get(keyOf(e.date));
    if (band === undefined) continue;
    const amount = Number(e.amount) || 0;
    totals.set(name, (totals.get(name) ?? 0) + amount);
    const row = values.get(name) ?? bands.map(() => 0);
    row[band] = (row[band] ?? 0) + amount;
    values.set(name, row);
  }
  const ranked = [...totals.keys()].toSorted(
    (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b),
  );
  const notes: string[] = [];
  let kept = ranked;
  if (ranked.length > MAX_SERIES) {
    const rest = ranked.slice(MAX_SERIES - 1);
    const other = bands.map(() => 0);
    for (const name of rest) {
      const row = values.get(name) ?? [];
      for (let i = 0; i < other.length; i++) {
        other[i] = (other[i] ?? 0) + (row[i] ?? 0);
      }
    }
    values.set(OTHER, other);
    kept = [...ranked.slice(0, MAX_SERIES - 1), OTHER];
    notes.push(
      `Showing the top ${MAX_SERIES - 1} categories; ${rest.length} more are grouped as Other.`,
    );
  }
  if (skipped > 0) notes.push(notCharted(skipped, "no category"));
  return {
    series: kept.map((name) => ({ name, values: values.get(name) ?? [] })),
    notes,
  };
}

/** The note for rows the dimension has no value for. Phrased count-first so
 * it does not have to agree with the number. */
function notCharted(count: number, missing: string): string {
  return `Not charted: ${countLabel(count)} with ${missing}.`;
}
