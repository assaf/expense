import type { Location, Settings } from "~/lib/types";

export { readSettings, writeSettings } from "~/lib/store.server";

/** Mileage reimbursement rate for a calendar year, as a decimal string. */
export async function mileageRateForYear(
  settings: Settings,
  year: string,
): Promise<string> {
  return settings.mileageRates[year] ?? "";
}

/** The configured home location (used as first/last stop of mileage routes). */
export function homeLocation(settings: Settings): Location {
  return {
    address: settings.homeAddress,
    lat: settings.homeLat,
    lng: settings.homeLng,
  };
}
