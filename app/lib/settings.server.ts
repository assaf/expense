import type { Location, Settings } from "~/lib/types";

export { readSettings, writeSettings } from "~/lib/store.server";

/** The configured home location (used as first/last stop of mileage routes). */
export function homeLocation(settings: Settings): Location {
  return {
    address: settings.homeAddress,
    lat: settings.homeLat,
    lng: settings.homeLng,
  };
}
