import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { geocode } from "~/lib/maps.server";

/** The live Places Text Search answer for the branch OpenStreetMap lacks
 * (captured 2026-10-14), so the parse is pinned to a real payload. */
const placesBody = JSON.parse(
  readFileSync("test/fixtures/places/hsbc-beverly-hills.json", "utf8"),
) as unknown;

/**
 * A business name OpenStreetMap has no record of: Nominatim comes back empty
 * and the keyed provider answers. Covers the whole cascade — the request the
 * code builds (URL, field mask, query), the parse of a real response, and the
 * canonical address — which is the part the offline suite could not reach.
 */
describe("business-name geocoding (real payload)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("resolves the branch from a live Places response", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        calls.push({ url: href, init: init ?? {} });
        // OpenStreetMap has no HSBC in Beverly Hills; Places does.
        if (href.includes("nominatim.openstreetmap.org")) {
          return { ok: true, json: async () => [] };
        }
        return { ok: true, json: async () => placesBody };
      }),
    );

    const result = await geocode("hsbc bank, Beverly Hills");
    expect(result.address).toBe("445 North Bedford Drive, Beverly Hills, CA");
    expect(result.lat).toBeCloseTo(34.0685011, 6);
    expect(result.lng).toBeCloseTo(-118.4061058, 6);

    const placesCall = calls.find((c) =>
      c.url.includes("places.googleapis.com"),
    );
    expect(placesCall?.url).toBe(
      "https://places.googleapis.com/v1/places:searchText",
    );
    const headers = placesCall?.init.headers as Record<string, string>;
    expect(headers["X-Goog-FieldMask"]).toBe(
      "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location",
    );
  });
});
