import type { Location } from "~/lib/types";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const METERS_PER_MILE = 1609.344;

interface NominatimResult {
  lat: string;
  lon: string;
}

/** Geocode a free-text address to coordinates via Nominatim (no API key). */
export async function geocode(address: string): Promise<Location> {
  const trimmed = address.trim();
  if (!trimmed) return { address, lat: null, lng: null };
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(trimmed)}`;
  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim usage policy requires a descriptive User-Agent.
        "User-Agent": "expense-personal/1.0 (assaf@labnotes.org)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { address, lat: null, lng: null };
    const json = (await res.json()) as NominatimResult[];
    const hit = json[0];
    if (!hit) return { address, lat: null, lng: null };
    return {
      address,
      lat: Number(hit.lat),
      lng: Number(hit.lon),
    };
  } catch {
    return { address, lat: null, lng: null };
  }
}

interface RouteResult {
  distanceMiles: number;
  coords: [number, number][]; // [lat, lng]
  approximate: boolean;
}

/**
 * Compute the driving distance for a closed route:
 *   locations[0] → locations[1] → ... → locations[n-1] → locations[0]
 * Uses OSRM; falls back to straight-line (Haversine) when unavailable.
 */
async function computeRouteDistance(
  locations: Location[],
): Promise<RouteResult> {
  const points = locations.filter(
    (l): l is Location & { lat: number; lng: number } =>
      l.lat !== null && l.lng !== null && l.address.trim() !== "",
  );
  if (points.length < 2) {
    return { distanceMiles: 0, coords: [], approximate: false };
  }

  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${OSRM_URL}/${coords}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        routes?: {
          distance: number;
          geometry?: { coordinates: [number, number][] };
        }[];
      };
      const route = json.routes?.[0];
      if (route) {
        const geomCoords = route.geometry?.coordinates ?? [];
        return {
          distanceMiles: route.distance / METERS_PER_MILE,
          coords: geomCoords.map(([lng, lat]) => [lat, lng]),
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
  return {
    distanceMiles: meters / METERS_PER_MILE,
    coords: points.map((p) => [p.lat, p.lng]),
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
}> {
  const rateNum = Number(rate);
  // Geocode addresses missing coordinates.
  const geocoded = await Promise.all(
    locations.map(async (l) =>
      l.lat === null || l.lng === null ? geocode(l.address) : l,
    ),
  );
  const route = await computeRouteDistance(geocoded);
  const distanceStr =
    route.distanceMiles > 0 ? route.distanceMiles.toFixed(2) : "";
  const amount =
    route.distanceMiles > 0 && Number.isFinite(rateNum)
      ? (route.distanceMiles * rateNum).toFixed(2)
      : "";
  return {
    locations: geocoded,
    distanceMiles: distanceStr,
    amount,
    approximate: route.approximate,
    coords: route.coords,
  };
}
