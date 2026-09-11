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

function osrmJson(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A well-formed OSRM answer to a closed-loop request: 100 km, with the
 * start repeated as the last waypoint. */
function osrmLoop(): unknown {
  return {
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
    waypoints: [
      { location: [-122.68, 45.52] },
      { location: [-122.33, 47.61] },
      { location: [-122.68, 45.52] },
    ],
  };
}

describe("maps wire shapes", () => {
  it("uses a well-formed OSRM route (100km → 62.14 mi at the given rate)", async () => {
    const fetchMock = osrmJson(osrmLoop());
    const result = await recomputeMileage([PDX, SEA], "0.70", {
      roundTrip: true,
    });
    // A round trip repeats the start: OSRM never closes a loop by itself.
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/-122.68,45.52;-122.33,47.61;-122.68,45.52?",
    );
    expect(result.approximate).toBe(false);
    expect(result.distanceMiles).toBe("62.14");
    expect(result.amount).toBe("43.50");
    expect(result.returnCoords.length).toBeGreaterThan(0);
  });

  it("routes a one-way trip over its stops, with no return leg", async () => {
    const fetchMock = osrmJson(osrmLoop());
    const result = await recomputeMileage([PDX, SEA], "0.70", {
      roundTrip: false,
    });
    // The request asks for the stops only.
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/-122.68,45.52;-122.33,47.61?",
    );
    expect(result.distanceMiles).toBe("62.14");
    expect(result.amount).toBe("43.50");
    // Nothing to draw coming back, and the geometry is the whole drive.
    expect(result.returnCoords).toEqual([]);
    expect(result.coords).toHaveLength(2);
  });

  it("halves the trip when a one-way drive falls back to straight lines", async () => {
    osrmJson({ error: "route not found" });
    const there = await recomputeMileage([PDX, SEA], "0.70", {
      roundTrip: false,
    });
    const back = await recomputeMileage([PDX, SEA], "0.70", {
      roundTrip: true,
    });
    expect(there.approximate).toBe(true);
    expect(there.amount).not.toMatch(/NaN/);
    // The fallback adds the leg home only when the trip returns there.
    expect(there.returnCoords).toEqual([]);
    expect(back.returnCoords.length).toBeGreaterThan(0);
    expect(Number(there.distanceMiles)).toBeCloseTo(
      Number(back.distanceMiles) / 2,
      0,
    );
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
