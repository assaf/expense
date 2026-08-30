import { afterEach, describe, expect, it, vi } from "vitest";
import { geocode, recomputeMileage } from "~/lib/maps.server";

/**
 * The map providers are unkeyed public services whose response shapes are
 * trusted nowhere else: their values feed IRS-rate money math (OSRM's
 * distance → miles × rate) and stored coordinates (Nominatim's lat/lon).
 * A 200 response with an unexpected shape must fall back to the existing
 * approximate paths, never produce NaN.
 */

const PDX = { address: "Portland, OR", lat: 45.52, lng: -122.68 };
const SEA = { address: "Seattle, WA", lat: 47.61, lng: -122.33 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function osrmJson(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

describe("maps wire shapes", () => {
  it("uses a well-formed OSRM route (100km → 62.14 mi at the given rate)", async () => {
    osrmJson({
      routes: [
        {
          distance: 100_000,
          geometry: {
            coordinates: [
              [-122.68, 45.52],
              [-122.33, 47.61],
            ],
          },
        },
      ],
      // OSRM repeats the start as the last waypoint (closed-loop request).
      waypoints: [
        { location: [-122.68, 45.52] },
        { location: [-122.33, 47.61] },
        { location: [-122.68, 45.52] },
      ],
    });
    const result = await recomputeMileage([PDX, SEA], "0.70");
    expect(result.approximate).toBe(false);
    expect(result.distanceMiles).toBe("62.14");
    expect(result.amount).toBe("43.50");
  });

  it("falls back to the Haversine approximation when OSRM's shape is wrong", async () => {
    osrmJson({ error: "route not found" });
    const result = await recomputeMileage([PDX, SEA], "0.70");
    expect(result.approximate).toBe(true);
    // The fallback is a real finite distance, not NaN money.
    expect(result.distanceMiles).not.toBe("");
    expect(Number.isFinite(Number(result.distanceMiles))).toBe(true);
    expect(result.amount).not.toMatch(/NaN/);
  });

  it("returns null coordinates when Nominatim's shape is wrong", async () => {
    osrmJson({ unexpected: true });
    const location = await geocode("123 Main St");
    expect(location.lat).toBeNull();
    expect(location.lng).toBeNull();
    expect(location.address).toBe("123 Main St");
  });
});
