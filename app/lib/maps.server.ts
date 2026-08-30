import Decimal from "decimal.js";
import { z } from "zod";

import { mileageAmount } from "~/lib/mileage-rates";
import { geocodedLocations, type Location } from "~/lib/types";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const METERS_PER_MILE = 1609.344;

/** The app's descriptive User-Agent for map-service requests (Nominatim's
 * usage policy requires one; Carto tiles use the same identity). Shared
 * with the report-map tile fetcher (route-map.server.ts). */
export const MAP_USER_AGENT = "expense-personal/1.0 (assaf@labnotes.org)";

/** A Nominatim coordinate: a string that parses to a finite number. A
 * junk value must fall back to "no match", never become NaN lat/lng on a
 * mileage expense. */
const coordString = z
  .string()
  .refine((s) => s.trim() !== "" && Number.isFinite(Number(s)))
  .transform(Number);

const nominatimResultSchema = z.object({
  lat: coordString,
  lon: coordString,
  display_name: z.string(),
  address: z
    .object({
      house_number: z.string().optional(),
      road: z.string().optional(),
      city: z.string().optional(),
      town: z.string().optional(),
      village: z.string().optional(),
      county: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      /** State-level ISO code, e.g. "US-CA": the reliable source for the
       * postal abbreviation. */
      "ISO3166-2-lvl4": z.string().optional(),
    })
    .optional(),
});
type NominatimResult = z.infer<typeof nominatimResultSchema>;

/** The OSRM route response. `distance` must be a finite number: it is
 * divided straight into miles and multiplied by the IRS rate, and an
 * unchecked 200-with-error body would otherwise store NaN money. */
const osrmResponseSchema = z.object({
  routes: z.array(
    z.object({
      distance: z.number().finite(),
      geometry: z
        .object({
          coordinates: z.array(
            z.tuple([z.number().finite(), z.number().finite()]),
          ),
        })
        .optional(),
    }),
  ),
  // OSRM always sends waypoints; requiring them keeps the split-index
  // access below honest (a body without them falls back to Haversine).
  waypoints: z.array(
    z.object({
      location: z.tuple([z.number(), z.number()]).optional(),
    }),
  ),
});

/** US state + DC names → postal abbreviations. Fallback when the geocoder's
 * ISO3166-2-lvl4 code is missing; non-US states keep their full name. */
const US_STATE_ABBREVIATIONS: Record<string, string> = {
  Alabama: "AL",
  Alaska: "AK",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  "District of Columbia": "DC",
  Florida: "FL",
  Georgia: "GA",
  Hawaii: "HI",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  Massachusetts: "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
};

const US_COUNTRY_NAMES = new Set([
  "united states",
  "united states of america",
  "usa",
  "us",
]);

/** The state for the canonical address: postal abbreviation for US states
 * (from the geocoder's ISO code, or the name map), full name elsewhere. */
function stateAbbreviation(hit: NominatimResult): string {
  const a = hit.address ?? {};
  const iso = a["ISO3166-2-lvl4"] ?? "";
  if (iso.startsWith("US-")) return iso.slice(3);
  const name = a.state ?? "";
  return US_STATE_ABBREVIATIONS[name] ?? name;
}

/** The country for the canonical address: omitted for the US (the default),
 * full name otherwise. */
function countryName(hit: NominatimResult): string {
  const country = (hit.address?.country ?? "").trim();
  return country && !US_COUNTRY_NAMES.has(country.toLowerCase()) ? country : "";
}

/**
 * Build the canonical display address from the geocoder's own structured
 * parts: street, city, abbreviated state, and the country only when it is
 * not the US. Never guessed or invented. Falls back to the full
 * display_name when the structured parts are too sparse.
 */
function canonicalAddress(hit: NominatimResult): string {
  const a = hit.address ?? {};
  const street = [a.house_number ?? "", a.road ?? ""].join(" ").trim();
  const city = a.city ?? a.town ?? a.village ?? a.county ?? "";
  const parts = [street, city, stateAbbreviation(hit), countryName(hit)].filter(
    Boolean,
  );
  if (parts.length >= 2) return parts.join(", ");
  return hit.display_name ?? "";
}

/** "City, ST" locality of a match, the hint for geocoding the next partial
 * address in the same trip (street-like queries get the previous stop's
 * locality appended so they don't default to a faraway city). */
function localityHint(hit: NominatimResult): string {
  const a = hit.address ?? {};
  const city = a.city ?? a.town ?? a.village ?? a.county ?? "";
  if (!city) return "";
  const state = stateAbbreviation(hit);
  return state ? `${city}, ${state}` : city;
}

/** Best-effort locality hint ("City, ST") parsed from a canonical address
 * string: the last two comma segments. Used when the previous stop already
 * has coordinates but no structured geocoder data (e.g. loaded from a saved
 * expense). */
function localityFromAddress(address: string): string {
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.slice(-2).join(", ");
}

const STREET_SUFFIX =
  /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|pkwy|parkway|ct|court|cir|circle|pl|place|ter|terrace|hwy|highway|loop|row|sq|square)\.?$/i;

/** A street-like address (has a house number or ends in a street suffix).
 * Only these get the locality hint; a city-only query ("Los Angeles") must
 * geocode on its own, appending a previous city would point it somewhere
 * else entirely. */
function isStreetLike(address: string): boolean {
  return /\d/.test(address) || STREET_SUFFIX.test(address);
}

/** A single Nominatim lookup result: the canonical location plus the
 * locality hint for the next address in the trip. */
interface GeocodeMatch {
  location: Location;
  locality: string;
}

/**
 * Nominatim sometimes matches only the street and drops the house number
 * the user typed (no address point exists, so the top result is the road
 * itself). The number is the user's own input, never a guess, so it is
 * kept: prepend it when the geocoder's result doesn't already contain it.
 */
function preserveHouseNumber(typed: string, address: string): string {
  const match = typed.trim().match(/^(\d+[a-z]?)\b/i);
  if (!match) return address;
  const number = match[1]!;
  if (new RegExp(`\\b${RegExp.escape(number)}\\b`).test(address))
    return address;
  return `${number} ${address}`;
}

/** One Nominatim query (no locality inference). */
async function geocodeMatch(address: string): Promise<GeocodeMatch> {
  const trimmed = address.trim();
  const noMatch: GeocodeMatch = {
    location: { address, lat: null, lng: null },
    locality: "",
  };
  if (!trimmed) return noMatch;
  const url = `${NOMINATIM_URL}?format=json&addressdetails=1&limit=1&q=${encodeURIComponent(trimmed)}`;
  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim usage policy requires a descriptive User-Agent.
        "User-Agent": MAP_USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return noMatch;
    const parsed = z
      .array(nominatimResultSchema)
      .safeParse(await res.json().catch(() => null));
    if (!parsed.success) return noMatch;
    const hit = parsed.data[0];
    if (!hit) return noMatch;
    return {
      location: {
        address: preserveHouseNumber(address, canonicalAddress(hit) || address),
        lat: hit.lat,
        lng: hit.lon,
      },
      locality: localityHint(hit),
    };
  } catch {
    return noMatch;
  }
}

/**
 * Geocode one address, biasing street-like addresses toward the previous
 * stop's locality when the plain lookup lands far away. Without a hint (or
 * for a city-only query) this is a single Nominatim call; with a hint it
 * retries once with "city, ST" appended and keeps whichever result is
 * closer to the previous stop. Never guesses: both candidates come from
 * the geocoder.
 */
async function geocodeWithLocality(
  address: string,
  hint: string,
  prevCoord: { lat: number; lng: number } | null,
): Promise<GeocodeMatch> {
  const plain = await geocodeMatch(address);
  const plainLat = plain.location.lat;
  const plainLng = plain.location.lng;
  if (plainLat === null || plainLng === null) return plain;
  if (!isStreetLike(address) || !hint || !prevCoord) return plain;
  const plainLoc = { lat: plainLat, lng: plainLng };
  // The plain result is already near the previous stop; no retry needed.
  if (haversine(prevCoord, plainLoc) < 50_000) return plain;
  const hinted = await geocodeMatch(`${address}, ${hint}`);
  const hintedLat = hinted.location.lat;
  const hintedLng = hinted.location.lng;
  if (hintedLat === null || hintedLng === null) return plain;
  const hintedLoc = { lat: hintedLat, lng: hintedLng };
  const plainDist = haversine(prevCoord, plainLoc);
  const hintedDist = haversine(prevCoord, hintedLoc);
  return hintedDist < plainDist ? hinted : plain;
}

/** Geocode a free-text address to coordinates via Nominatim (no API key).
 * Returns the canonical (geocoded) address form; on no match or a network
 * failure the coordinates are null and the address stays as typed. Used for
 * single-address lookups (e.g. the start/end location in Settings); trip
 * geocoding goes through recomputeMileage, which threads the locality hint. */
export async function geocode(address: string): Promise<Location> {
  return (await geocodeMatch(address)).location;
}

interface RouteResult {
  distanceMiles: number;
  /** Route geometry in [lat, lng] (the outbound legs, start → last stop). */
  coords: [number, number][];
  /** Return leg (last stop → start) geometry in [lat, lng], drawn dashed
   *  on the map. Straight line when OSRM is unavailable. */
  returnCoords: [number, number][];
  approximate: boolean;
}

/**
 * Compute the driving distance for a closed route:
 *   locations[0] → locations[1] → ... → locations[n-1] → locations[0]
 * Uses OSRM; falls back to straight-line (Haversine) when unavailable.
 *
 * OSRM's route service connects waypoints in order but never closes the
 * loop, so the start is repeated as the last waypoint. The response then
 * carries the whole loop (outbound + return) in one call; the geometry is
 * split at the last real stop: its snapped location is a point on the
 * geometry, so the nearest geometry index is exactly where the return leg
 * begins; split there into `coords` (outbound) and `returnCoords` (return to start).
 */
async function computeRouteDistance(
  locations: Location[],
): Promise<RouteResult> {
  const points = geocodedLocations(locations).filter(
    (l) => l.address.trim() !== "",
  );
  if (points.length < 2) {
    return {
      distanceMiles: 0,
      coords: [],
      returnCoords: [],
      approximate: false,
    };
  }

  const loopParam = [...points, points[0]]
    .map((p) => `${p.lng},${p.lat}`)
    .join(";");
  const url = `${OSRM_URL}/${loopParam}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const parsed = osrmResponseSchema.safeParse(
        await res.json().catch(() => null),
      );
      const json = parsed.success ? parsed.data : null;
      const route = json?.routes[0];
      if (route && route.geometry) {
        const geom = route.geometry.coordinates;
        // The last real waypoint is second-to-last in the response (the
        // final entry is the repeated start). Its snapped location lies on
        // the geometry, so the nearest index is where the return leg
        // begins. Split exactly there.
        const lastStop = json
          ? json.waypoints[json.waypoints.length - 2]?.location
          : undefined;
        let split = geom.length;
        if (lastStop) {
          let best = Infinity;
          for (let i = 0; i < geom.length; i++) {
            const dx = geom[i]![0] - lastStop[0];
            const dy = geom[i]![1] - lastStop[1];
            const d2 = dx * dx + dy * dy;
            if (d2 < best) {
              best = d2;
              split = i;
            }
          }
        }
        const toLatLng = (g: [number, number][]): [number, number][] =>
          g.map(([lng, lat]): [number, number] => [lat, lng]);
        return {
          distanceMiles: route.distance / METERS_PER_MILE,
          coords: toLatLng(geom.slice(0, split)),
          returnCoords: split < geom.length ? toLatLng(geom.slice(split)) : [],
          approximate: false,
        };
      }
    }
  } catch {
    // fall through to Haversine
  }

  // Fallback: sum of straight-line segments including the return to start.
  const loop = [...points, points[0]];
  let meters = 0;
  for (let i = 1; i < loop.length; i++) {
    meters += haversine(loop[i - 1], loop[i]);
  }
  const last = points[points.length - 1];
  return {
    distanceMiles: meters / METERS_PER_MILE,
    coords: points.map((p) => [p.lat, p.lng]),
    returnCoords: [
      [last.lat, last.lng],
      [points[0]!.lat, points[0]!.lng],
    ],
    approximate: true,
  };
}

function haversine(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Recompute a mileage expense: geocode any un-geocoded addresses, compute the
 * route distance, and derive the amount from the per-year mileage rate.
 *
 * Un-geocoded addresses are geocoded in trip order, threading the previous
 * stop's locality ("city, ST") as a hint: a street-like address that would
 * otherwise default to a faraway city (e.g. "123 Main St" → some other
 * state) is retried with the previous stop's city/state appended and the
 * closer result is kept. City-only queries geocode on their own.
 *
 * The amount is the shared `mileageAmount` expression (mileage-rates.ts):
 * `distance × rate` with exact decimal math, rounded once to cents with
 * ROUND_HALF_UP (a half cent rounds up, e.g. 122.15 mi × $0.70 → $85.51).
 * The route distance is a float measurement (meters / mile), but
 * multiplying by the rate and rounding on a Decimal keeps the money side
 * exact.
 */
export async function recomputeMileage(
  locations: Location[],
  rate: string,
): Promise<{
  locations: Location[];
  distanceMiles: string;
  amount: string;
  approximate: boolean;
  coords: [number, number][];
  returnCoords: [number, number][];
}> {
  // Geocode addresses missing coordinates, threading the previous stop's
  // locality so a partial street address doesn't default to a faraway city.
  const geocoded: Location[] = [];
  let hint = "";
  let prevCoord: { lat: number; lng: number } | null = null;
  for (const l of locations) {
    if (l.lat !== null && l.lng !== null) {
      geocoded.push(l);
      prevCoord = { lat: l.lat, lng: l.lng };
      // No structured data for an already-geocoded stop, so the locality hint
      // comes from its canonical address string.
      const fromAddress = localityFromAddress(l.address);
      if (fromAddress) hint = fromAddress;
      continue;
    }
    const match = await geocodeWithLocality(l.address, hint, prevCoord);
    geocoded.push(match.location);
    if (match.location.lat !== null && match.location.lng !== null) {
      if (match.locality) hint = match.locality;
      prevCoord = { lat: match.location.lat, lng: match.location.lng };
    }
  }
  const route = await computeRouteDistance(geocoded);
  const distance = new Decimal(route.distanceMiles);
  const distanceStr = distance.gt(0) ? distance.toFixed(2) : "";
  // No rate configured for the year (or an unparseable one) → no amount,
  // not $0.00; mileageAmount returns "" for a missing/non-finite rate.
  const amount = mileageAmount(distanceStr, rate);
  return {
    locations: geocoded,
    distanceMiles: distanceStr,
    amount,
    approximate: route.approximate,
    coords: route.coords,
    returnCoords: route.returnCoords,
  };
}
