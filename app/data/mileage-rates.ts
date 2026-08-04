import type { MileageRateEntry } from "~/lib/mileage-rates";

/**
 * IRS standard mileage rates — the seed for the global `mileage_rates`
 * master table, synced by initStore at startup (see database.ts). Source:
 * the IRS standard-mileage-rates page; docs/2026-08-04 IRS standard mileage
 * rates.md holds the point-in-time snapshot with the source links.
 *
 * Update this array when the IRS publishes new rates (usually each December
 * for the coming year, plus occasional mid-year changes) — the next deploy
 * syncs it into every database, so the app never asks users to track rates.
 *
 * Periods are inclusive date ranges (YYYY-MM-DD). Charity is fixed by
 * statute at $0.14; moving is deductible for Armed Forces / Intelligence
 * Community members only and always matches the medical rate.
 */

/** Business rate per period. */
const BUSINESS: { startDate: string; endDate: string; rate: string }[] = [
  { startDate: "2026-07-01", endDate: "2026-12-31", rate: "0.76" },
  { startDate: "2026-01-01", endDate: "2026-06-30", rate: "0.725" },
  { startDate: "2025-01-01", endDate: "2025-12-31", rate: "0.70" },
  { startDate: "2024-01-01", endDate: "2024-12-31", rate: "0.67" },
  { startDate: "2023-01-01", endDate: "2023-12-31", rate: "0.655" },
  { startDate: "2022-07-01", endDate: "2022-12-31", rate: "0.625" },
  { startDate: "2022-01-01", endDate: "2022-06-30", rate: "0.585" },
  { startDate: "2021-01-01", endDate: "2021-12-31", rate: "0.56" },
  { startDate: "2020-01-01", endDate: "2020-12-31", rate: "0.575" },
  { startDate: "2019-01-01", endDate: "2019-12-31", rate: "0.58" },
  { startDate: "2018-01-01", endDate: "2018-12-31", rate: "0.545" },
  { startDate: "2017-01-01", endDate: "2017-12-31", rate: "0.535" },
  { startDate: "2016-01-01", endDate: "2016-12-31", rate: "0.54" },
  { startDate: "2015-01-01", endDate: "2015-12-31", rate: "0.575" },
  { startDate: "2014-01-01", endDate: "2014-12-31", rate: "0.56" },
  { startDate: "2013-01-01", endDate: "2013-12-31", rate: "0.565" },
  { startDate: "2012-01-01", endDate: "2012-12-31", rate: "0.555" },
  { startDate: "2011-07-01", endDate: "2011-12-31", rate: "0.555" },
  { startDate: "2011-01-01", endDate: "2011-06-30", rate: "0.51" },
];

/** Medical rate per period (moving always matches it). */
const MEDICAL: { startDate: string; endDate: string; rate: string }[] = [
  { startDate: "2026-07-01", endDate: "2026-12-31", rate: "0.235" },
  { startDate: "2026-01-01", endDate: "2026-06-30", rate: "0.205" },
  { startDate: "2025-01-01", endDate: "2025-12-31", rate: "0.21" },
  { startDate: "2024-01-01", endDate: "2024-12-31", rate: "0.21" },
  { startDate: "2023-01-01", endDate: "2023-12-31", rate: "0.22" },
  { startDate: "2022-07-01", endDate: "2022-12-31", rate: "0.22" },
  { startDate: "2022-01-01", endDate: "2022-06-30", rate: "0.18" },
  { startDate: "2021-01-01", endDate: "2021-12-31", rate: "0.16" },
  { startDate: "2020-01-01", endDate: "2020-12-31", rate: "0.17" },
  { startDate: "2019-01-01", endDate: "2019-12-31", rate: "0.20" },
  { startDate: "2018-01-01", endDate: "2018-12-31", rate: "0.18" },
  { startDate: "2017-01-01", endDate: "2017-12-31", rate: "0.17" },
  { startDate: "2016-01-01", endDate: "2016-12-31", rate: "0.19" },
  { startDate: "2015-01-01", endDate: "2015-12-31", rate: "0.23" },
  { startDate: "2014-01-01", endDate: "2014-12-31", rate: "0.235" },
  { startDate: "2013-01-01", endDate: "2013-12-31", rate: "0.24" },
  { startDate: "2012-01-01", endDate: "2012-12-31", rate: "0.23" },
  { startDate: "2011-07-01", endDate: "2011-12-31", rate: "0.235" },
  { startDate: "2011-01-01", endDate: "2011-06-30", rate: "0.19" },
];

/** Charity rate (fixed by statute) per period. */
const CHARITY: { startDate: string; endDate: string; rate: string }[] =
  BUSINESS.map(({ startDate, endDate }) => ({
    startDate,
    endDate,
    rate: "0.14",
  }));

export const MILEAGE_RATES: MileageRateEntry[] = [
  ...BUSINESS.map((p) => ({ ...p, type: "business" })),
  ...CHARITY.map((p) => ({ ...p, type: "charity" })),
  ...MEDICAL.map((p) => ({ ...p, type: "medical" })),
  ...MEDICAL.map((p) => ({ ...p, type: "moving" })),
] as MileageRateEntry[];
