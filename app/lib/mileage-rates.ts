import { parseAmount } from "~/lib/money";
import type { MileageType } from "~/lib/types";

/**
 * One IRS mileage rate row: a (type, period) pair. `endDate` "" means
 * open-ended. Rates are dollars per mile as decimal strings ("0.76",
 * "0.235" for the half-cent medical/moving rates).
 *
 * This module is pure (no server-only imports) so the same lookup and
 * amount math run on the client (the editor's instant recompute on
 * date/type change) and the server (route recompute, MCP, exports). Money
 * math uses decimal.js like the rest of the app.
 */
export interface MileageRateEntry {
  type: MileageType;
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  /** YYYY-MM-DD, inclusive; "" = open-ended. */
  endDate: string;
  rate: string;
}

/** The four IRS mileage types, in editor order. */
export const MILEAGE_TYPES: MileageType[] = [
  "business",
  "charity",
  "medical",
  "moving",
];

/** Display labels for the mileage types (editor select, settings table). */
export const MILEAGE_TYPE_LABELS: Record<MileageType, string> = {
  business: "Business",
  charity: "Charity",
  medical: "Medical",
  moving: "Moving",
};

export function isMileageType(v: unknown): v is MileageType {
  return typeof v === "string" && (MILEAGE_TYPES as string[]).includes(v);
}

/**
 * The rate (dollars per mile) in effect for a date and type, or "" when no
 * period in the table covers the date. YYYY-MM-DD strings compare
 * lexicographically, which is chronological, so no date parsing is needed.
 * If several rows overlap (the seed never does), the latest startDate wins.
 */
export function mileageRateFor(
  rates: MileageRateEntry[],
  date: string,
  type: MileageType,
): string {
  let best = "";
  let bestStart = "";
  for (const r of rates) {
    if (r.type !== type) continue;
    if (r.startDate > date) continue;
    if (r.endDate !== "" && r.endDate < date) continue;
    if (r.startDate >= bestStart) {
      best = r.rate;
      bestStart = r.startDate;
    }
  }
  return best;
}

/** The period covering `date` — its inclusive dates and the four type
 * rates, for a compact "current rate" display. When no published period
 * covers the date (e.g. before the IRS announces next year's rate), falls
 * back to the most recent known period and marks itself not current.
 * null only when the table is empty. */
export function currentMileageRates(
  rates: MileageRateEntry[],
  date: string,
): {
  isCurrent: boolean;
  startDate: string;
  endDate: string;
  byType: Record<MileageType, string>;
} | null {
  // Group the flat rows by period; each period has one row per type.
  const periods = new Map<string, Map<MileageType, string>>();
  for (const r of rates) {
    const key = `${r.startDate}|${r.endDate}`;
    const row = periods.get(key) ?? new Map<MileageType, string>();
    row.set(r.type, r.rate);
    periods.set(key, row);
  }
  if (periods.size === 0) return null;
  const keys = [...periods.keys()];
  const covers = keys.find((key) => {
    const [start, end] = key.split("|");
    return start! <= date && (end === "" || date <= end!);
  });
  // The fallback is the latest published period by start date (then end
  // date) — independent of the input order.
  const latest = [...periods.keys()].toSorted((a, b) => {
    const [as, ae] = a.split("|");
    const [bs, be] = b.split("|");
    return bs!.localeCompare(as!) || (be ?? "").localeCompare(ae ?? "");
  })[0]!;
  const key = covers ?? latest;
  const [startDate, endDate] = key.split("|");
  const byType = {} as Record<MileageType, string>;
  for (const [t, rate] of periods.get(key)!) byType[t] = rate;
  return {
    isCurrent: covers !== undefined,
    startDate: startDate!,
    endDate: endDate!,
    byType,
  };
}

/**
 * Distance × rate, rounded half-up to cents with exact decimal math:
 * 122.15 mi × $0.70 → $85.51, 122.15 × $0.235 → $28.71. The single money
 * expression for every caller — the editor, the server route recompute
 * (`recomputeMileage` in maps.server.ts), the MCP tools, and exports all
 * produce identical amounts. Returns "" when the distance is
 * missing/unparseable/≤ 0 or the rate is missing/unparseable/non-finite —
 * a missing rate means "no amount", never $0.00.
 */
export function mileageAmount(distanceMiles: string, rate: string): string {
  const d = parseAmount(distanceMiles);
  const r = parseAmount(rate);
  if (d === null || r === null || !d.isFinite() || !r.isFinite() || d.lte(0)) {
    return "";
  }
  return d.times(r).toFixed(2);
}

/**
 * "2026" for a full calendar year; "Jul 1 – Dec 31, 2026" for a split
 * period (or "Jul 1, 2025 – Jan 15, 2026" across years). Used by the
 * Settings mileage-rate display and anywhere a rate period needs a compact
 * label.
 */
export function periodLabel(start: string, end: string): string {
  if (start.length === 10 && end.length === 10) {
    const sy = start.slice(0, 4);
    const ey = end.slice(0, 4);
    if (sy === ey && start === `${sy}-01-01` && end === `${ey}-12-31`) {
      return sy;
    }
  }
  const fmt = (d: string, withYear: boolean) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" as const } : {}),
      timeZone: "UTC",
    });
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${fmt(start, false)} – ${fmt(end, true)}`
    : `${fmt(start, true)} – ${fmt(end, true)}`;
}

/**
 * "$0.76"-style display for a rate string: always two decimals, and a
 * half-cent rate keeps its third digit (0.235 → "0.235", 0.70 → "0.70") —
 * never rounded to a wrong value.
 */
export function formatRate(rate: string): string {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(rate.trim());
  if (!m) return rate.trim();
  let frac = (m[2] ?? "").padEnd(2, "0");
  if (frac.length > 2) frac = frac.replace(/0+$/, "");
  return `${m[1]}.${frac}`;
}

/**
 * "Business · $0.70/mi" — the compact per-type rate label used by the
 * editor's mileage summary and the report PDF. Callers resolve the rate
 * for the trip's (date, type) first (`mileageRateFor`), then render this.
 */
export function mileageRateLabel(type: MileageType, rate: string): string {
  return `${MILEAGE_TYPE_LABELS[type]} · $${formatRate(rate)}/mi`;
}
