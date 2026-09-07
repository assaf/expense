import type { MonthBucket } from "~/lib/insights";

/** The chart sums amounts as numbers (buckets own the math); format at
 * display with the same USD style as formatAmount. */
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
/**
 * A bar chart of monthly expense totals. Pure SVG, no chart library:
 * the app keeps heavy client deps lazy-loaded, and twelve bars don't
 * justify one. Amounts live in native <title> tooltips; labels thin out
 * when the window is wide enough to crowd them.
 */
export function MonthlyChart({ buckets }: { buckets: MonthBucket[] }) {
  const max = Math.max(...buckets.map((b) => b.total), 0);
  const width = 600;
  const height = 200;
  const padTop = 16;
  const padBottom = 24;
  const plotHeight = height - padTop - padBottom;
  const n = buckets.length;
  const slot = width / Math.max(n, 1);
  const barWidth = Math.min(slot * 0.62, 44);
  const labelEvery = Math.ceil(n / 12);

  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Monthly expense totals"
      >
        {max > 0 ? (
          <>
            {[0.5, 1].map((f) => (
              <line
                key={f}
                x1="0"
                x2={width}
                y1={padTop + plotHeight * (1 - f)}
                y2={padTop + plotHeight * (1 - f)}
                className="stroke-gray-200 dark:stroke-gray-700"
                strokeWidth="1"
                strokeDasharray="3 4"
              />
            ))}
            <text
              x="2"
              y={padTop + 2}
              className="fill-gray-400 dark:fill-gray-500"
              fontSize="10"
            >
              {usd.format(max)}
            </text>
          </>
        ) : null}
        {buckets.map((b, i) => {
          const h = max > 0 ? (b.total / max) * plotHeight : 0;
          const x = i * slot + (slot - barWidth) / 2;
          const y = padTop + plotHeight - h;
          const title = b.count
            ? `${b.label}: ${usd.format(b.total)} · ${b.count} ${b.count === 1 ? "expense" : "expenses"}`
            : `${b.label}: no expenses`;
          return (
            <g key={b.key}>
              {b.total > 0 ? (
                <path
                  d={`M${x} ${padTop + plotHeight} L${x} ${y + 3} Q${x} ${y} ${x + 3} ${y} L${x + barWidth - 3} ${y} Q${x + barWidth} ${y} ${x + barWidth} ${y + 3} L${x + barWidth} ${padTop + plotHeight} Z`}
                  className="fill-teal-600 dark:fill-teal-400"
                >
                  <title>{title}</title>
                </path>
              ) : (
                <line
                  x1={x + barWidth / 2}
                  x2={x + barWidth / 2}
                  y1={padTop + plotHeight - 1}
                  y2={padTop + plotHeight}
                  className="stroke-gray-300 dark:stroke-gray-600"
                  strokeWidth="2"
                >
                  <title>{title}</title>
                </line>
              )}
              {i % labelEvery === 0 ? (
                <text
                  x={i * slot + slot / 2}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize="10"
                  className="fill-gray-500 dark:fill-gray-400"
                >
                  {b.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
