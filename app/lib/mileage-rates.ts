import type { MileageType } from "~/lib/types";

/**
 * One IRS mileage rate row: a (type, period) pair. `endDate` "" means
 * open-ended. Rates are dollars per mile as decimal strings ("0.76",
 * "0.235" for the half-cent medical/moving rates).
 *
 * This module is pure (no server-only imports) so the same lookup and
 * amount math run on the client (the editor's instant recompute on
 * date/type change) and the server (route recompute, MCP, exports).
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

/** The most recent known rate for a type (its latest period) — a fallback
 * for "current rate" displays when today's period isn't in the table yet
 * (e.g. the IRS hasn't published next year's rate). */
export function latestRate(
  rates: MileageRateEntry[],
  type: MileageType,
): string {
  let best = "";
  let bestStart = "";
  for (const r of rates) {
    if (r.type !== type) continue;
    if (r.startDate >= bestStart) {
      bestStart = r.startDate;
      best = r.rate;
    }
  }
  return best;
}

/**
 * Distance × rate, rounded half-up to cents, with exact integer math (no
 * floating point): 122.15 mi × $0.70 → $85.51, 122.15 × $0.235 → $28.71.
 * Returns "" when the distance is missing/unparseable or ≤ 0 — a missing
 * rate means "no amount", never $0.00. One formula everywhere: the editor
 * (client) and recomputeMileage (server) produce identical amounts.
 */
export function mileageAmount(distanceMiles: string, rate: string): string {
  const d = parseScaled(distanceMiles, 2); // distance in hundredths of a mile
  const r = parseScaled(rate, 3); // rate in thousandths of a dollar
  if (d === null || r === null || d <= 0) return "";
  // amount in cents = d×r×100 / 10^5 = d×r / 1000
  const num = d * r;
  let cents = Math.floor(num / 1000);
  if (num % 1000 >= 500) cents += 1;
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Parse a non-negative decimal string into an integer scaled by 10^scale
 * (e.g. "122.15" @2 → 12215). null when malformed or out of safe range. */
function parseScaled(s: string, scale: number): number | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, scale).padEnd(scale, "0");
  const num = Number(m[1]) * 10 ** scale + Number(frac);
  return Number.isSafeInteger(num) ? num : null;
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
