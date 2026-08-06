import { randomBytes, scryptSync } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";

// errors.server imports @sentry/react-router, which drags in
// @opentelemetry/api — broken under vite-node's ESM resolution. Mock the
// Sentry module; captureError only reaches Sentry when isInitialized() is
// true, so the dedupe logic under test is unaffected.
vi.mock("@sentry/react-router", () => ({
  isInitialized: () => false,
  captureException: vi.fn(),
}));

import {
  isComplete,
  isReceiptComplete,
  isMileageComplete,
} from "~/lib/completeness";
import { captureErrorOnce } from "~/lib/errors.server";
import {
  formatAmount,
  normalizeAmount,
  formatDate,
  mileageMerchant,
  merchantLabel,
  yearOf,
  summarizeByReport,
} from "~/lib/format";
import Decimal from "decimal.js";
import { parseAmount } from "~/lib/money";
import { recomputeMileage, geocode } from "~/lib/maps.server";
import { hashPassword, needsRehash, verifyPassword } from "~/lib/passwords";
import {
  currentMileageRates,
  formatRate,
  mileageAmount,
  mileageRateFor,
} from "~/lib/mileage-rates";
import { renderRouteMap } from "~/lib/route-map.server";
import sharp from "sharp";
import type { ReceiptExpense, MileageExpense } from "~/lib/types";

const makeReceipt = (
  overrides: Partial<ReceiptExpense> = {},
): ReceiptExpense => ({
  id: "test1",
  type: "receipt",
  date: "2026-01-15",
  report: "2026 Test",
  category: "Testing",
  description: "",
  amount: "42.50",
  merchant: "Test Store",
  imageFile: "receipt.jpg",
  imageMime: "image/jpeg",
  originalName: "receipt.jpg",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

const makeMileage = (
  overrides: Partial<MileageExpense> = {},
): MileageExpense => ({
  id: "test2",
  type: "mileage",
  mileageType: "business",
  date: "2026-03-10",
  report: "2026 Test",
  category: "Travel",
  description: "",
  amount: "22.40",
  locations: [
    { address: "A", lat: 34.05, lng: -118.24 },
    { address: "B", lat: 34.06, lng: -118.25 },
  ],
  distanceMiles: "32.00",
  route: { coords: [], returnCoords: [] },
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

describe("Completeness", () => {
  it("a complete receipt is complete", () => {
    expect(isReceiptComplete(makeReceipt())).toBe(true);
  });

  it("a receipt missing merchant is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ merchant: "" }))).toBe(false);
  });

  it("a receipt with zero amount is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ amount: "0.00" }))).toBe(false);
  });

  it("a receipt missing image is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ imageFile: "" }))).toBe(false);
  });

  it("a zero-amount mileage is incomplete", () => {
    expect(isMileageComplete(makeMileage({ amount: "0.00" }))).toBe(false);
  });

  it("a complete mileage is complete", () => {
    expect(isMileageComplete(makeMileage())).toBe(true);
  });

  it("isComplete dispatches correctly", () => {
    expect(isComplete(makeReceipt())).toBe(true);
    expect(isComplete(makeMileage())).toBe(true);
    expect(isComplete(makeReceipt({ merchant: "" }))).toBe(false);
  });
});

describe("Format helpers", () => {
  it("formats amount as currency", () => {
    expect(formatAmount("42.50")).toBe("$42.50");
    expect(formatAmount("0")).toBe("$0.00");
    expect(formatAmount("")).toBe("—");
  });

  it("parseAmount parses into an exact Decimal or null", () => {
    expect(parseAmount("42.50")?.toString()).toBe("42.5");
    expect(parseAmount("0.10")?.add("0.20").toString()).toBe("0.3");
    expect(parseAmount("")).toBe(null);
    expect(parseAmount("abc")).toBe(null);
  });

  it("normalizeAmount rounds to 2 decimals (exact half-up)", () => {
    expect(normalizeAmount("42.5")).toBe("42.50");
    expect(normalizeAmount("42.501")).toBe("42.50");
    expect(normalizeAmount("1.005")).toBe("1.01");
    expect(normalizeAmount("42.995")).toBe("43.00");
    expect(normalizeAmount("")).toBe("");
  });

  it("formats dates", () => {
    expect(formatDate("2026-01-15")).toContain("Jan");
    expect(formatDate("")).toBe("—");
  });

  it("builds mileage merchant label", () => {
    expect(mileageMerchant("32.00", "0.70")).toBe("32.00 mi @ $0.70 / mi");
    // No rate configured for the year — the distance still shows.
    expect(mileageMerchant("32.00", "")).toBe("32.00 mi");
    expect(mileageMerchant("", "0.70")).toBe("");
  });

  it("prefixes the merchant label with the mileage type", () => {
    const rates = [
      {
        type: "business" as const,
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        rate: "0.725",
      },
    ];
    expect(merchantLabel(makeMileage({ date: "2026-03-10" }), rates)).toBe(
      "Business · 32.00 mi @ $0.725 / mi",
    );
    // A trip without a distance shows just the type.
    expect(
      merchantLabel(
        makeMileage({ date: "2026-03-10", distanceMiles: "" }),
        rates,
      ),
    ).toBe("Business");
  });

  it("gets year from date", () => {
    expect(yearOf("2026-03-10")).toBe("2026");
    expect(yearOf("")).toBe(String(new Date().getFullYear()));
  });

  it("summarizes expenses per report with exact totals", () => {
    const summary = summarizeByReport([
      makeReceipt({ report: "A", amount: "10.00" }),
      makeReceipt({ report: "A", amount: "5.50" }),
      makeReceipt({ report: "", amount: "3.00" }),
      makeReceipt({ report: "B", amount: "" }),
    ]);
    expect(summary.get("A")?.count).toBe(2);
    expect(summary.get("A")?.total.toString()).toBe("15.5");
    expect(summary.get("B")?.count).toBe(1);
    expect(summary.get("B")?.total.isZero()).toBe(true);
    // Expenses without a report are skipped unless the bucket is requested.
    expect(summary.has("Unassigned")).toBe(false);
  });

  it("summarizeByReport can bucket unassigned expenses", () => {
    const summary = summarizeByReport(
      [makeReceipt({ report: "", amount: "3.00" })],
      { includeUnassigned: true },
    );
    expect(summary.get("Unassigned")?.total.toString()).toBe("3");
  });

  it("report totals don't drift on repeated float-unfriendly additions", () => {
    // 0.1 + 0.2 in float64 is 0.30000000000000004; 100 × $0.10 sums to
    // 9.99999999999998. Decimal addition stays exact.
    const expenses = Array.from({ length: 100 }, (_, i) =>
      makeReceipt({ report: "A", amount: "0.10", id: `r${i}` }),
    );
    const total = summarizeByReport(expenses).get("A")!.total;
    expect(total.toString()).toBe("10");
    expect(formatAmount(total)).toBe("$10.00");
  });

  it("formatAmount accepts a Decimal directly", () => {
    expect(formatAmount(parseAmount("0.10")!.add("0.20"))).toBe("$0.30");
  });
});

describe("Decimal money math", () => {
  it("adds without IEEE 754 drift (0.1 + 0.2 = 0.3 exactly)", () => {
    const sum = new Decimal("0.1").add("0.2");
    expect(sum.toString()).toBe("0.3");
    // JS float addition would produce 0.30000000000000004.
    expect(sum.isFinite()).toBe(true);
  });

  it("multiplies with exact decimal precision", () => {
    // 122.15 × 0.70 = 85.505 — exactly.
    const product = new Decimal("122.15").mul("0.70");
    expect(product.toString()).toBe("85.505");
  });

  it("isZero detects true zero and nothing else", () => {
    expect(new Decimal("0").isZero()).toBe(true);
    expect(new Decimal("0.00").isZero()).toBe(true);
    expect(new Decimal("0.01").isZero()).toBe(false);
    expect(new Decimal("-0").isZero()).toBe(true);
  });

  it("toFixed(2) rounds half-up (the app standard)", () => {
    // Decimal.toFixed defaults to ROUND_HALF_UP (bankers' rounding is opt-in).
    expect(new Decimal("1.005").toFixed(2)).toBe("1.01");
    expect(new Decimal("1.004").toFixed(2)).toBe("1.00");
    expect(new Decimal("85.505").toFixed(2)).toBe("85.51");
    expect(new Decimal("85.504").toFixed(2)).toBe("85.50");
  });

  it("parses zero with trailing decimals — toString drops trailing zeros", () => {
    const d = new Decimal("0.00");
    expect(d.toString()).toBe("0");
    expect(d.isZero()).toBe(true);
    expect(d.toFixed(2)).toBe("0.00");
  });

  it("preserves exact values from normalizeAmount output", () => {
    // Regression guard: the format and money paths must agree on the
    // exact string representations that pass between them.
    const parsed = new Decimal("42.50");
    expect(parsed.toString()).toBe("42.5");
    expect(parsed.toFixed(2)).toBe("42.50");
  });
});

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
    // the US country dropped (it's the default) — never the typed shorthand.
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
    // Nominatim has no address point for "50 W 3rd Street" — the top match
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
    // The city's own name + abbreviated state — never the county it sits in.
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
    // The geocoder only knows the plain query — a city name — and must not
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
    // The LA lookup failed — the San Francisco result is kept rather than
    // guessing or dropping the address.
    expect(r.locations[1]!.address).toBe("123 Main St, San Francisco, CA");
  });

  it("skips the hinted retry when the plain result is already near the previous stop", async () => {
    // The plain query already resolves in/near Los Angeles — no second
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
    // The geocode failure doesn't crash — the bad address is kept as-is
    // with null coordinates.
    expect(r.locations[1]!.address).toBe("Unknown Place");
    expect(r.locations[1]!.lat).toBeNull();
    expect(r.locations[1]!.lng).toBeNull();
  });
});

describe("mileage rates (master table helpers)", () => {
  const rates = [
    {
      type: "business" as const,
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      rate: "0.76",
    },
    {
      type: "business" as const,
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      rate: "0.725",
    },
    {
      type: "business" as const,
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      rate: "0.70",
    },
    {
      type: "charity" as const,
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      rate: "0.14",
    },
    {
      type: "charity" as const,
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      rate: "0.14",
    },
    {
      type: "medical" as const,
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      rate: "0.235",
    },
    {
      type: "medical" as const,
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      rate: "0.205",
    },
    {
      type: "moving" as const,
      startDate: "2026-07-01",
      endDate: "2026-12-31",
      rate: "0.235",
    },
  ];

  it("picks the rate for the trip's date and type", () => {
    expect(mileageRateFor(rates, "2026-08-15", "business")).toBe("0.76");
    expect(mileageRateFor(rates, "2026-03-15", "business")).toBe("0.725");
    expect(mileageRateFor(rates, "2025-06-01", "business")).toBe("0.70");
    expect(mileageRateFor(rates, "2026-08-15", "charity")).toBe("0.14");
    expect(mileageRateFor(rates, "2026-08-15", "medical")).toBe("0.235");
    expect(mileageRateFor(rates, "2026-03-15", "medical")).toBe("0.205");
    expect(mileageRateFor(rates, "2026-08-15", "moving")).toBe("0.235");
  });

  it("returns no rate outside any period (never a guess)", () => {
    expect(mileageRateFor(rates, "2010-06-01", "business")).toBe("");
    expect(mileageRateFor(rates, "2027-01-01", "business")).toBe("");
    // Period boundaries are inclusive.
    expect(mileageRateFor(rates, "2026-07-01", "business")).toBe("0.76");
    expect(mileageRateFor(rates, "2026-06-30", "business")).toBe("0.725");
  });

  it("currentMileageRates returns the covering period and all four types", () => {
    const current = currentMileageRates(rates, "2026-08-15")!;
    expect(current.isCurrent).toBe(true);
    expect(current.startDate).toBe("2026-07-01");
    expect(current.endDate).toBe("2026-12-31");
    expect(current.byType).toEqual({
      business: "0.76",
      charity: "0.14",
      medical: "0.235",
      moving: "0.235",
    });
  });

  it("currentMileageRates falls back to the latest period when none covers", () => {
    const fallback = currentMileageRates(rates, "2027-01-01")!;
    expect(fallback.isCurrent).toBe(false);
    expect(fallback.startDate).toBe("2026-07-01");
    expect(fallback.byType.business).toBe("0.76");
    expect(currentMileageRates([], "2026-08-15")).toBeNull();
  });

  it("multiplies distance × rate with exact half-up rounding", () => {
    // 122.15 × 0.70 = 85.505 → 85.51 (half rounds up).
    expect(mileageAmount("122.15", "0.70")).toBe("85.51");
    // 122.15 × 0.235 = 28.70525 → 28.71.
    expect(mileageAmount("122.15", "0.235")).toBe("28.71");
    expect(mileageAmount("10.00", "0.76")).toBe("7.60");
    expect(mileageAmount("10.00", "0.725")).toBe("7.25");
    expect(mileageAmount("10.00", "0.14")).toBe("1.40");
    expect(mileageAmount("0.01", "0.70")).toBe("0.01");
  });

  it("produces no amount without a distance or rate", () => {
    expect(mileageAmount("", "0.70")).toBe("");
    expect(mileageAmount("10.00", "")).toBe("");
    expect(mileageAmount("0", "0.70")).toBe("");
    expect(mileageAmount("abc", "0.70")).toBe("");
    expect(mileageAmount("10.00", "junk")).toBe("");
  });

  it("formats rates for display without rounding away a half cent", () => {
    expect(formatRate("0.76")).toBe("0.76");
    expect(formatRate("0.70")).toBe("0.70");
    expect(formatRate("0.725")).toBe("0.725");
    expect(formatRate("0.235")).toBe("0.235");
    expect(formatRate("0.760")).toBe("0.76");
    expect(formatRate("0.7")).toBe("0.70");
  });
});

describe("route map rendering (report PDF)", () => {
  /** Count pixels within `tol` of a target RGB triple. */
  async function countPixels(
    png: Buffer,
    target: [number, number, number],
    tol = 24,
  ): Promise<number> {
    const { data, info } = await sharp(png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    let n = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (
        Math.abs(data[i]! - target[0]) <= tol &&
        Math.abs(data[i + 1]! - target[1]) <= tol &&
        Math.abs(data[i + 2]! - target[2]) <= tol
      )
        n++;
    }
    return n;
  }

  /** A solid 256×256 tile so tests stay offline (the renderer is given a
   * fake tile fetcher — the real one hits the Carto basemap). Violet — no
   * color in the schematic fallback or the route is anywhere near it, so
   * tile pixels are unambiguous. */
  async function tilePng(): Promise<Buffer> {
    return sharp({
      create: { width: 256, height: 256, channels: 3, background: "#7c3aed" },
    })
      .png()
      .toBuffer();
  }

  const blue: [number, number, number] = [37, 99, 235]; // route line (#2563eb)
  const tile: [number, number, number] = [124, 58, 237]; // fake tile (#7c3aed)

  it("renders a real map: tiles with the route drawn on top", async () => {
    const calls: [number, number, number][] = [];
    const trip = makeMileage({
      route: {
        coords: [
          [34.05, -118.24],
          [34.06, -118.25],
          [34.04, -118.27],
        ],
        returnCoords: [
          [34.04, -118.27],
          [34.05, -118.24],
        ],
      },
    });
    const png = await renderRouteMap(trip, {
      tileFetcher: async (z, x, y) => {
        calls.push([z, x, y]);
        return tilePng();
      },
    });
    expect(png).not.toBeNull();
    const meta = await sharp(png!).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(460);
    expect(meta.height).toBe(220);
    // Tiles were requested at a sane zoom and actually embedded (the fake
    // tile color covers most of the canvas).
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([z]) => z >= 2 && z <= 19)).toBe(true);
    expect(await countPixels(png!, tile)).toBeGreaterThan(1000);
    // The route is drawn on top of the tiles.
    expect(await countPixels(png!, blue)).toBeGreaterThan(200);
  });

  it("renders straight-line trips (no saved geometry) over tiles", async () => {
    // The makeMileage fixture has two geocoded stops and no route geometry.
    const png = await renderRouteMap(makeMileage(), {
      tileFetcher: async () => tilePng(),
    });
    expect(png).not.toBeNull();
    expect(await countPixels(png!, tile)).toBeGreaterThan(1000);
    expect(await countPixels(png!, blue)).toBeGreaterThan(200);
  });

  it("falls back to the schematic when the tile server is unreachable", async () => {
    const trip = makeMileage({
      route: {
        coords: [
          [34.05, -118.24],
          [34.06, -118.25],
        ],
        returnCoords: [
          [34.06, -118.25],
          [34.05, -118.24],
        ],
      },
    });
    const png = await renderRouteMap(trip, {
      tileFetcher: async () => {
        throw new Error("offline");
      },
    });
    expect(png).not.toBeNull();
    // No tile pixels, but the blue route is still drawn.
    expect(await countPixels(png!, tile)).toBe(0);
    expect(await countPixels(png!, blue)).toBeGreaterThan(200);
  });

  it("returns null when there is nothing drawable", async () => {
    const trip = makeMileage({
      locations: [{ address: "Lone stop", lat: null, lng: null }],
      route: { coords: [], returnCoords: [] },
    });
    expect(
      await renderRouteMap(trip, { tileFetcher: async () => tilePng() }),
    ).toBeNull();
  });
});

describe("password hashing (scrypt)", () => {
  it("round-trips a password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    await expect(
      verifyPassword("correct horse battery staple", stored),
    ).resolves.toBe(true);
    await expect(verifyPassword("wrong password", stored)).resolves.toBe(false);
  });

  it("stores a self-describing string with the current scrypt parameters", async () => {
    const stored = await hashPassword("s3cret!");
    expect(stored).toMatch(/^\$scrypt\$N=65536,r=8,p=1\$/);
    const [, salt, hash] = stored.slice("$scrypt$".length).split("$");
    // 16-byte salt + 64-byte derived key, base64url.
    expect(Buffer.from(salt!, "base64url")).toHaveLength(16);
    expect(Buffer.from(hash!, "base64url")).toHaveLength(64);
  });

  it("salts per password — two hashes of the same password differ", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    await expect(verifyPassword("same-password", a)).resolves.toBe(true);
    await expect(verifyPassword("same-password", b)).resolves.toBe(true);
  });

  it("verifies legacy salt:hash rows derived with the default scrypt cost", async () => {
    // The pre-format-change shape: 16-byte hex salt + 64-byte hex key,
    // derived with Node's default scrypt parameters (N=2^14, r=8, p=1).
    const salt = randomBytes(16).toString("hex");
    const key = scryptSync("legacy-password", salt, 64).toString("hex");
    const legacy = `${salt}:${key}`;
    await expect(verifyPassword("legacy-password", legacy)).resolves.toBe(true);
    await expect(verifyPassword("not-it", legacy)).resolves.toBe(false);
  });

  it("needsRehash flags legacy rows but not current ones", async () => {
    const salt = randomBytes(16).toString("hex");
    const key = scryptSync("legacy-password", salt, 64).toString("hex");
    expect(needsRehash(`${salt}:${key}`)).toBe(true);
    expect(needsRehash(await hashPassword("current"))).toBe(false);
  });

  it("fails closed on malformed stored strings", async () => {
    await expect(verifyPassword("x", "")).resolves.toBe(false);
    await expect(verifyPassword("x", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("x", ":hash-only")).resolves.toBe(false);
    await expect(
      verifyPassword("x", "$scrypt$N=65536,r=8,p=1$salt$hash"),
    ).resolves.toBe(false);
    // N=3 is not a power of two — garbage params fail closed.
    await expect(
      verifyPassword("x", "$scrypt$N=3,r=8,p=1$AAAA$AAAA"),
    ).resolves.toBe(false);
    // A legacy row with a truncated key fails closed.
    await expect(
      verifyPassword("x", `${randomBytes(16).toString("hex")}:abcd`),
    ).resolves.toBe(false);
  });
});

describe("captureErrorOnce", () => {
  it("reports each error object once no matter how many paths surface it", () => {
    const error = new Error("boom");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The stream onError fires first, then renderToReadableStream rejects
      // with the same object and handleError forwards it again — the second
      // report must be a no-op.
      captureErrorOnce(error, { url: "/expense/1" });
      captureErrorOnce(error, { url: "/expense/1", method: "GET" });
      expect(spy).toHaveBeenCalledTimes(1);
      // Distinct errors still report.
      captureErrorOnce(new Error("other"));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
