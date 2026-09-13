import { describe, it, expect, vi, afterEach } from "vitest";
import { recomputeMileage, geocode } from "~/lib/maps.server";

describe("geocode canonicalization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the geocoder's canonical address with an abbreviated state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            lat: "37.4224",
            lon: "-122.0841",
            display_name:
              "1600 Amphitheatre Parkway, Mountain View, Santa Clara County, California, 94043, United States",
            address: {
              house_number: "1600",
              road: "Amphitheatre Parkway",
              city: "Mountain View",
              state: "California",
              country: "United States",
            },
          },
        ],
      }),
    );
    const result = await geocode("1600 Amphitheatre Pkwy");
    expect(result.lat).toBe(37.4224);
    expect(result.lng).toBe(-122.0841);
    // Street + city copied from the geocoded match, state abbreviated, and
    // the US country dropped (it's the default), never the typed shorthand.
    expect(result.address).toBe("1600 Amphitheatre Parkway, Mountain View, CA");
  });

  it("keeps the full state name and country for non-US matches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            lat: "-33.8688",
            lon: "151.2093",
            display_name: "Sydney, New South Wales, Australia",
            address: {
              city: "Sydney",
              state: "New South Wales",
              country: "Australia",
              "ISO3166-2-lvl4": "AU-NSW",
            },
          },
        ],
      }),
    );
    const result = await geocode("Sydney");
    expect(result.address).toBe("Sydney, New South Wales, Australia");
  });

  it("keeps the typed house number when the geocoder matches only the street", async () => {
    // Nominatim has no address point for "50 W 3rd Street"; the top match
    // is the road itself, with no house_number. The user's number must not
    // be dropped.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            lat: "34.0729",
            lon: "-118.3721",
            display_name:
              "West 3rd Street, Beverly Grove, Los Angeles, Los Angeles County, California, 90048, United States",
            address: {
              road: "West 3rd Street",
              city: "Los Angeles",
              state: "California",
              country: "United States",
              "ISO3166-2-lvl4": "US-CA",
            },
          },
        ],
      }),
    );
    const result = await geocode("50 W 3rd Street, Los Angeles, CA");
    expect(result.address).toBe("50 West 3rd Street, Los Angeles, CA");
  });

  it("does not duplicate a house number the geocoder already matched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            lat: "34.0729",
            lon: "-118.3721",
            display_name: "50, West 3rd Street, Los Angeles, CA",
            address: {
              house_number: "50",
              road: "West 3rd Street",
              city: "Los Angeles",
              state: "California",
              country: "United States",
              "ISO3166-2-lvl4": "US-CA",
            },
          },
        ],
      }),
    );
    const result = await geocode("50 W 3rd Street, Los Angeles, CA");
    expect(result.address).toBe("50 West 3rd Street, Los Angeles, CA");
  });

  it("keeps the typed address with null coords when there is no match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    );
    const result = await geocode("Nowhere Lane ZZ");
    expect(result.lat).toBeNull();
    expect(result.lng).toBeNull();
    expect(result.address).toBe("Nowhere Lane ZZ");
  });

  it("falls back to the full display_name when structured parts are sparse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            lat: "37.42",
            lon: "-122.08",
            display_name: "Mountain View, California, United States",
            address: { city: "Mountain View" },
          },
        ],
      }),
    );
    const result = await geocode("Mountain View");
    expect(result.address).toBe("Mountain View, California, United States");
  });

  it("requests structured address details so a city query geocodes to the city, not the county", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          lat: "34.0537",
          lon: "-118.2428",
          display_name:
            "Los Angeles, Los Angeles County, California, United States",
          address: {
            city: "Los Angeles",
            county: "Los Angeles County",
            state: "California",
            country: "United States",
          },
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocode("Los Angeles CA");
    // The city's own name + abbreviated state, never the county it sits in.
    expect(result.address).toBe("Los Angeles, CA");
    expect(result.lat).toBe(34.0537);
    // addressdetails=1 is what makes the structured city/state/country come
    // back from Nominatim in the first place.
    expect(fetchMock.mock.calls[0]![0] as string).toContain("addressdetails=1");
  });
});

describe("recomputeMileage locality hint", () => {
  const LA = {
    address: "Los Angeles, CA",
    lat: 34.05,
    lng: -118.24,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stub Nominatim: the plain query resolves somewhere far away (e.g. the
   * San Francisco area), the hinted query (with the previous stop's
   * locality appended) resolves in Los Angeles. OSRM is stubbed for the
   * route math afterwards. */
  function stubGeocoderWithHint(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string | URL | Request) => {
        const href =
          url instanceof URL
            ? url.href
            : url instanceof Request
              ? url.url
              : url;
        if (href.includes("/route/v1/driving")) {
          return {
            ok: true,
            json: async () => ({
              routes: [
                {
                  distance: 10_000,
                  geometry: { coordinates: [[-118.24, 34.05]] },
                },
              ],
            }),
          };
        }
        const q = decodeURIComponent(href.match(/q=([^&]*)/)?.[1] ?? "");
        if (q === "123 Main St, Los Angeles, CA") {
          return {
            ok: true,
            json: async () => [
              {
                lat: "34.0522",
                lon: "-118.2437",
                display_name: "123 Main St, Los Angeles, CA",
                address: {
                  house_number: "123",
                  road: "Main St",
                  city: "Los Angeles",
                  state: "California",
                  country: "United States",
                  "ISO3166-2-lvl4": "US-CA",
                },
              },
            ],
          };
        }
        if (q === "123 Main St") {
          // The plain query would default to a faraway city (the bug).
          return {
            ok: true,
            json: async () => [
              {
                lat: "37.7749",
                lon: "-122.4194",
                display_name: "123 Main St, San Francisco, CA",
                address: {
                  house_number: "123",
                  road: "Main St",
                  city: "San Francisco",
                  state: "California",
                  country: "United States",
                  "ISO3166-2-lvl4": "US-CA",
                },
              },
            ],
          };
        }
        return { ok: true, json: async () => [] };
      }),
    );
  }

  it("biases a street-like address toward the previous stop's city", async () => {
    stubGeocoderWithHint();
    // The first stop is already geocoded in LA; the second is a street
    // address without a city.
    const r = await recomputeMileage(
      [LA, { address: "123 Main St", lat: null, lng: null }],
      "0.70",
    );
    expect(r.locations[1]!.address).toBe("123 Main St, Los Angeles, CA");
    expect(r.locations[1]!.lat).toBe(34.0522);
  });

  it("leaves a city-only query alone (no locality appended)", async () => {
    // The geocoder only knows the plain query (a city name) and must not
    // have "Los Angeles, CA" appended (that would point it at a place named
    // "New York" inside LA County).
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/route/v1/driving")) {
        return {
          ok: true,
          json: async () => ({
            routes: [
              {
                distance: 10_000,
                geometry: { coordinates: [[-118.24, 34.05]] },
              },
            ],
          }),
        };
      }
      const q = decodeURIComponent(href.match(/q=([^&]*)/)?.[1] ?? "");
      expect(q).toBe("New York"); // exactly one call, no hint appended
      return {
        ok: true,
        json: async () => [
          {
            lat: "40.7128",
            lon: "-74.0060",
            display_name: "New York, NY",
            address: {
              city: "New York",
              state: "New York",
              country: "United States",
              "ISO3166-2-lvl4": "US-NY",
            },
          },
        ],
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await recomputeMileage(
      [LA, { address: "New York", lat: null, lng: null }],
      "0.70",
    );
    expect(r.locations[1]!.address).toBe("New York, NY");
  });

  it("falls back to the plain result when the hinted lookup fails", async () => {
    // The street doesn't exist in the previous stop's city: the hinted
    // query comes back empty and the plain result is kept.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string | URL | Request) => {
        const href =
          url instanceof URL
            ? url.href
            : url instanceof Request
              ? url.url
              : url;
        if (href.includes("/route/v1/driving")) {
          return {
            ok: true,
            json: async () => ({
              routes: [
                {
                  distance: 10_000,
                  geometry: { coordinates: [[-118.24, 34.05]] },
                },
              ],
            }),
          };
        }
        const q = decodeURIComponent(href.match(/q=([^&]*)/)?.[1] ?? "");
        if (q === "123 Main St") {
          return {
            ok: true,
            json: async () => [
              {
                lat: "37.7749",
                lon: "-122.4194",
                display_name: "123 Main St, San Francisco, CA",
                address: {
                  house_number: "123",
                  road: "Main St",
                  city: "San Francisco",
                  state: "California",
                  country: "United States",
                  "ISO3166-2-lvl4": "US-CA",
                },
              },
            ],
          };
        }
        expect(q).toBe("123 Main St, Los Angeles, CA"); // the hinted retry
        return { ok: true, json: async () => [] }; // no match in LA
      }),
    );

    const r = await recomputeMileage(
      [LA, { address: "123 Main St", lat: null, lng: null }],
      "0.70",
    );
    // The LA lookup failed, so the San Francisco result is kept rather than
    // guessing or dropping the address.
    expect(r.locations[1]!.address).toBe("123 Main St, San Francisco, CA");
  });

  it("skips the hinted retry when the plain result is already near the previous stop", async () => {
    // The plain query already resolves in/near Los Angeles, so no second
    // Nominatim call is made (the 50km short-circuit).
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/route/v1/driving")) {
        return {
          ok: true,
          json: async () => ({
            routes: [
              {
                distance: 10_000,
                geometry: { coordinates: [[-118.24, 34.05]] },
              },
            ],
          }),
        };
      }
      const q = decodeURIComponent(href.match(/q=([^&]*)/)?.[1] ?? "");
      expect(q).toBe("123 Main St"); // only the plain call
      return {
        ok: true,
        json: async () => [
          {
            lat: "33.98",
            lon: "-118.25", // El Segundo, ~8km from downtown LA
            display_name: "123 Main St, El Segundo, CA",
            address: {
              house_number: "123",
              road: "Main St",
              city: "El Segundo",
              state: "California",
              country: "United States",
              "ISO3166-2-lvl4": "US-CA",
            },
          },
        ],
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await recomputeMileage(
      [LA, { address: "123 Main St", lat: null, lng: null }],
      "0.70",
    );
    expect(r.locations[1]!.address).toBe("123 Main St, El Segundo, CA");
    // Exactly one Nominatim call (the plain query) + the OSRM route call.
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u.includes("/search")).length).toBe(1);
  });
});

describe("recomputeMileage money math", () => {
  const A = { address: "A", lat: 34.05, lng: -118.2 };
  const B = { address: "B", lat: 34.06, lng: -118.1 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubOsrm(distanceMeters: number): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          routes: [
            {
              distance: distanceMeters,
              geometry: {
                coordinates: [
                  [-118.2, 34.05],
                  [-118.1, 34.06],
                ],
              },
            },
          ],
          // OSRM always sends waypoints (start, stops, repeated start).
          waypoints: [
            { location: [-118.2, 34.05] },
            { location: [-118.1, 34.06] },
            { location: [-118.2, 34.05] },
          ],
        }),
      }),
    );
  }

  it("rounds distance × rate to cents with ROUND_HALF_UP (not float toFixed)", async () => {
    // 122.15 mi × $0.70 is exactly $85.505 → $85.51. Float64 computes the
    // product a hair below .505, so .toFixed(2) yields "85.50"; decimal.js
    // keeps the exact half and rounds up.
    stubOsrm(122.15 * 1609.344);
    const r = await recomputeMileage([A, B], "0.70");
    expect(r.distanceMiles).toBe("122.15");
    expect(r.amount).toBe("85.51");
  });

  it("produces no amount when no rate is configured (not $0.00)", async () => {
    stubOsrm(10_000);
    const r = await recomputeMileage([A, B], "");
    expect(r.distanceMiles).toBe("6.21");
    expect(r.amount).toBe("");
  });

  it("produces no amount for an unparseable rate", async () => {
    stubOsrm(10_000);
    const r = await recomputeMileage([A, B], "not-a-rate");
    expect(r.amount).toBe("");
  });

  it("handles OSRM returning no routes by falling back to Haversine", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ routes: [] }),
      }),
    );
    const r = await recomputeMileage([A, B], "0.70");
    // Geocoded stops are preserved, and the Haversine fallback computes
    // a straight-line distance rather than leaving it empty.
    expect(r.locations).toHaveLength(2);
    expect(r.approximate).toBe(true);
    expect(r.distanceMiles).not.toBe("");
    expect(r.amount).not.toBe("");
  });

  it("falls back to Haversine when OSRM responds with HTTP 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }),
    );
    const r = await recomputeMileage([A, B], "0.70");
    // Haversine fallback produces a non-empty distance; approximate=true.
    expect(r.approximate).toBe(true);
    expect(r.distanceMiles).not.toBe("");
    expect(r.amount).not.toBe("");
    expect(r.locations).toHaveLength(2);
  });

  it("survives a Nominatim fetch error for geocoding while preserving existing stops", async () => {
    // One stop already geocoded, the other needs a lookup that fails.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string | URL) => {
        const href = String(url);
        if (href.includes("/route/v1/driving")) {
          return {
            ok: true,
            json: async () => ({
              routes: [
                {
                  distance: 10_000,
                  geometry: { coordinates: [[-118.2, 34.05]] },
                },
              ],
            }),
          };
        }
        // Nominatim: fail for the unknown address.
        if (href.includes("q=Unknown")) {
          return { ok: false, status: 429 };
        }
        return { ok: true, json: async () => [] };
      }),
    );
    const r = await recomputeMileage(
      [A, { address: "Unknown Place", lat: null, lng: null }],
      "0.70",
    );
    // The geocode failure doesn't crash: the bad address is kept as-is
    // with null coordinates.
    expect(r.locations[1]!.address).toBe("Unknown Place");
    expect(r.locations[1]!.lat).toBeNull();
    expect(r.locations[1]!.lng).toBeNull();
  });
});
