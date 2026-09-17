import type { ReactNode } from "react";
import { countLabel, formatUsd } from "~/lib/format";
import type { ChartBand, ChartPlan, ChartSeries } from "~/lib/insight-charts";

/**
 * The insights chart: one shape per plan, drawn from numbers the app already
 * computed. Pure SVG and plain markup, no chart library: the shapes are a
 * handful of rects and a polyline, and the app keeps heavy client
 * dependencies lazy-loaded. Amounts live in native <title> tooltips, so the
 * figures are reachable without a hover-only affordance.
 *
 * The ranked shapes render as markup rather than SVG: a bar whose label and
 * amount are real text stays legible at 320px, where a scaled viewBox would
 * shrink them to a few pixels.
 */

/** Series fills, in stack order; the last is the guard's "Other". Every
 * entry carries its dark twin (scripts/check-dark-mode.mjs enforces it). */
const SERIES_FILL = [
  "fill-teal-600 dark:fill-teal-400",
  "fill-sky-600 dark:fill-sky-400",
  "fill-amber-600 dark:fill-amber-400",
  "fill-violet-600 dark:fill-violet-400",
  "fill-gray-400 dark:fill-gray-500",
];

/** The same colors for the legend swatches. */
const SERIES_SWATCH = [
  "bg-teal-600 dark:bg-teal-400",
  "bg-sky-600 dark:bg-sky-400",
  "bg-amber-600 dark:bg-amber-400",
  "bg-violet-600 dark:bg-violet-400",
  "bg-gray-400 dark:bg-gray-500",
];

/** The viewBox the bar and line shapes are drawn in. */
const WIDTH = 600;
const HEIGHT = 200;
const PAD_TOP = 16;
const PAD_BOTTOM = 24;
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;

/** The chart's accessible name, including the axis the guard settled on. */
function chartLabel(plan: ChartPlan): string {
  const by = plan.grain ? ` by ${plan.grain}` : "";
  switch (plan.shape) {
    case "by-category":
      return "Expenses by category";
    case "top-merchants":
      return "Spend by merchant";
    case "category-trend":
      return `Expense categories${by}`;
    case "cumulative":
      return `Cumulative expense total${by}`;
    default:
      return `Expense totals${by}`;
  }
}

/** One bar's tooltip: what it is, what it came to, and how many expenses
 * stand behind it. */
function bandTip(band: ChartBand): string {
  return band.count
    ? `${band.label}: ${formatUsd(band.total)} · ${countLabel(band.count)}`
    : `${band.label}: no expenses`;
}

/** How often to print an axis label: enough for a phone, never crowding. */
function labelEvery(bands: ChartBand[]): number {
  return Math.ceil(bands.length / 12);
}

/** The x position of one band's bar in the shared bar geometry. */
function barGeometry(n: number): { slot: number; width: number } {
  const slot = WIDTH / Math.max(n, 1);
  return { slot, width: Math.min(slot * 0.62, 44) };
}

export function InsightChart({ plan }: { plan: ChartPlan }) {
  const ranked = plan.shape === "by-category" || plan.shape === "top-merchants";
  // A ranking with nothing to rank has no chart: the exchange's own header
  // already says the window is empty.
  if (ranked && plan.bands.length === 0) return null;
  return (
    <figure>
      {ranked ? (
        <RankedBars bands={plan.bands} label={chartLabel(plan)} />
      ) : plan.shape === "cumulative" ? (
        <CumulativeLine bands={plan.bands} label={chartLabel(plan)} />
      ) : plan.shape === "category-trend" ? (
        <CategoryTrend
          bands={plan.bands}
          series={plan.series}
          label={chartLabel(plan)}
        />
      ) : (
        <MonthlyBars bands={plan.bands} label={chartLabel(plan)} />
      )}
      {plan.notes.length > 0 ? (
        <figcaption className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {plan.notes.join(" ")}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** Bars of period totals: the default shape, and the one a rolled-up axis
 * still draws (the axis labels carry the grain). */
function MonthlyBars({ bands, label }: { bands: ChartBand[]; label: string }) {
  const max = Math.max(...bands.map((b) => b.total), 0);
  const { slot, width: barWidth } = barGeometry(bands.length);
  const every = labelEvery(bands);
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="w-full"
      role="img"
      aria-label={label}
    >
      <Guides max={max} />
      {bands.map((b, i) => {
        const h = max > 0 ? (b.total / max) * PLOT_HEIGHT : 0;
        const x = i * slot + (slot - barWidth) / 2;
        const y = PAD_TOP + PLOT_HEIGHT - h;
        return (
          <g key={b.key}>
            {b.total > 0 ? (
              <path
                d={`M${x} ${PAD_TOP + PLOT_HEIGHT} L${x} ${y + 3} Q${x} ${y} ${x + 3} ${y} L${x + barWidth - 3} ${y} Q${x + barWidth} ${y} ${x + barWidth} ${y + 3} L${x + barWidth} ${PAD_TOP + PLOT_HEIGHT} Z`}
                className="fill-teal-600 dark:fill-teal-400"
              >
                <title>{bandTip(b)}</title>
              </path>
            ) : (
              <line
                x1={x + barWidth / 2}
                x2={x + barWidth / 2}
                y1={PAD_TOP + PLOT_HEIGHT - 1}
                y2={PAD_TOP + PLOT_HEIGHT}
                className="stroke-gray-300 dark:stroke-gray-600"
                strokeWidth="2"
              >
                <title>{bandTip(b)}</title>
              </line>
            )}
            {i % every === 0 ? (
              <AxisLabel x={i * slot + slot / 2}>{b.label}</AxisLabel>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** A running total across the window: where the window ends is the window's
 * answer, so the line's last point is the figure that matters. */
function CumulativeLine({
  bands,
  label,
}: {
  bands: ChartBand[];
  label: string;
}) {
  const { slot } = barGeometry(bands.length);
  let running = 0;
  const points = bands.map((band, i) => {
    running += band.total;
    return { band, x: i * slot + slot / 2, total: running };
  });
  const max = points.at(-1)?.total ?? 0;
  const y = (v: number): number =>
    max > 0 ? PAD_TOP + PLOT_HEIGHT * (1 - v / max) : PAD_TOP + PLOT_HEIGHT;
  const line = points
    .map((p, i) => `${i ? "L" : "M"}${p.x} ${y(p.total)}`)
    .join(" ");
  const first = points[0];
  const last = points.at(-1);
  const every = labelEvery(bands);
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="w-full"
      role="img"
      aria-label={label}
    >
      <Guides max={max} />
      {first && last ? (
        <path
          d={`${line} L${last.x} ${PAD_TOP + PLOT_HEIGHT} L${first.x} ${PAD_TOP + PLOT_HEIGHT} Z`}
          className="fill-teal-600 dark:fill-teal-400"
          fillOpacity="0.12"
        />
      ) : null}
      <path
        d={line}
        className="stroke-teal-600 dark:stroke-teal-400"
        strokeWidth="2"
        fill="none"
      />
      {points.map((p, i) => (
        <g key={p.band.key}>
          <rect
            x={p.x - slot / 2}
            y={PAD_TOP}
            width={slot}
            height={PLOT_HEIGHT}
            fill="transparent"
          >
            <title>{`${bandTip(p.band)} · ${formatUsd(p.total)} so far`}</title>
          </rect>
          {i % every === 0 ? (
            <AxisLabel x={p.x}>{p.band.label}</AxisLabel>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

/** Stacked bars: the category mix per band. The legend is part of the chart
 * (nothing else says which color is which), so it renders inside the
 * figure. */
function CategoryTrend({
  bands,
  series,
  label,
}: {
  bands: ChartBand[];
  series: ChartSeries[];
  label: string;
}) {
  const stacked = bands.map((_, i) =>
    series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const max = Math.max(...stacked, 0);
  const { slot, width: barWidth } = barGeometry(bands.length);
  const every = labelEvery(bands);
  return (
    <>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={label}
      >
        <Guides max={max} />
        {bands.map((band, i) => {
          const x = i * slot + (slot - barWidth) / 2;
          let bottom = PAD_TOP + PLOT_HEIGHT;
          return (
            <g key={band.key}>
              {series.map((s, si) => {
                const value = s.values[i] ?? 0;
                if (value <= 0) return null;
                const h = max > 0 ? (value / max) * PLOT_HEIGHT : 0;
                bottom -= h;
                return (
                  <rect
                    key={s.name}
                    x={x}
                    y={bottom}
                    width={barWidth}
                    height={h}
                    className={SERIES_FILL[si % SERIES_FILL.length]}
                  >
                    <title>{`${band.label} · ${s.name}: ${formatUsd(value)}`}</title>
                  </rect>
                );
              })}
              {i % every === 0 ? (
                <AxisLabel x={i * slot + slot / 2}>{band.label}</AxisLabel>
              ) : null}
            </g>
          );
        })}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
        {series.map((s, i) => (
          <li key={s.name} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 rounded-sm ${SERIES_SWATCH[i % SERIES_SWATCH.length]}`}
            />
            {s.name}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Ranked bars (categories, merchants): a bar per row, with the label and
 * the amount as real text so both stay readable at 320px. */
function RankedBars({ bands, label }: { bands: ChartBand[]; label: string }) {
  const max = Math.max(...bands.map((b) => b.total), 0);
  return (
    <ul aria-label={label} className="space-y-1.5">
      {bands.map((b) => (
        <li
          key={b.key}
          title={bandTip(b)}
          className="flex items-center gap-2 text-sm"
        >
          <span className="w-1/3 shrink-0 truncate text-gray-700 dark:text-gray-300">
            {b.label}
          </span>
          <span className="h-2.5 flex-1 rounded-sm bg-gray-100 dark:bg-gray-800">
            <span
              aria-hidden="true"
              className="block h-full rounded-sm bg-teal-600 dark:bg-teal-400"
              style={{ width: `${max > 0 ? (b.total / max) * 100 : 0}%` }}
            />
          </span>
          <span className="w-16 shrink-0 text-right tabular-nums text-gray-700 dark:text-gray-300">
            {formatUsd(b.total)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The 50% and 100% guides, plus the axis ceiling. Absent when there is
 * nothing to scale against, which is also when a bar has no height. The
 * ceiling label sits above the 100% guide, or the dashes strike it. */
function Guides({ max }: { max: number }) {
  if (max <= 0) return null;
  return (
    <>
      {[0.5, 1].map((f) => (
        <line
          key={f}
          x1="0"
          x2={WIDTH}
          y1={PAD_TOP + PLOT_HEIGHT * (1 - f)}
          y2={PAD_TOP + PLOT_HEIGHT * (1 - f)}
          className="stroke-gray-200 dark:stroke-gray-700"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
      ))}
      <text
        x="2"
        y={PAD_TOP - 6}
        className="fill-gray-400 dark:fill-gray-500"
        fontSize="10"
      >
        {formatUsd(max)}
      </text>
    </>
  );
}

/** One tick on the x axis of a time chart. */
function AxisLabel({ x, children }: { x: number; children: ReactNode }) {
  return (
    <text
      x={x}
      y={HEIGHT - 8}
      textAnchor="middle"
      fontSize="10"
      className="fill-gray-500 dark:fill-gray-400"
    >
      {children}
    </text>
  );
}
