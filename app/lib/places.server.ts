import { z } from "zod";

import { placesApiKey } from "~/lib/env";

/**
 * Business and POI lookups Google Maps knows and OpenStreetMap does not.
 *
 * The geocoder is Nominatim, which reads OpenStreetMap: a bank, shop or
 * restaurant whose *name* nobody has mapped has no match there, and neither
 * does a query that combines a name with a city (Nominatim fails the whole
 * query rather than the unmatched word). Places API (New) Text Search does
 * know businesses, so `searchPlace` answers exactly that case.
 *
 * Billing: the fields below are the Pro tier (`displayName`,
 * `formattedAddress`, `addressComponents`, `location`); requesting an
 * Enterprise field — rating, opening hours, phone, website — would bill the
 * call at the next SKU up, so the mask stays as it is. Text Search Pro has
 * 5,000 free calls a month, and this runs only when the free geocoder misses.
 *
 * Places API (Legacy) cannot be enabled for new Google Cloud projects
 * (since October 2026), so this is the v1 API:
 * `POST https://places.googleapis.com/v1/places:searchText`.
 */

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const TIMEOUT_MS = 8_000;

/** Pro-tier fields only; see the billing note above. */
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
].join(",");

const addressComponentSchema = z.object({
  longText: z.string().optional(),
  shortText: z.string().optional(),
  types: z.array(z.string()).optional(),
});

const placeSchema = z.object({
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  addressComponents: z.array(addressComponentSchema).optional(),
  location: z
    .object({ latitude: z.number(), longitude: z.number() })
    .optional(),
});

const searchResponseSchema = z.object({
  places: z.array(placeSchema).optional(),
});

/** A matched place, already reduced to the parts an address is built from.
 * Component order and membership vary between requests (Google documents
 * both), so each part is looked up by its type name, never by index. */
export interface PlaceMatch {
  /** The place's own name, e.g. "HSBC Bank USA". Empty when it has none. */
  name: string;
  /** Street line: house number and road, from the place's own components. */
  street: string;
  city: string;
  /** State or province in its full form (the caller abbreviates US states). */
  state: string;
  /** Country in its full form; the caller drops it for the US. */
  country: string;
  lat: number;
  lng: number;
  /** Google's own formatted address, the fallback when the parts are sparse. */
  formattedAddress: string;
}

/** The first component carrying one of `types`. */
function component(
  components: z.infer<typeof addressComponentSchema>[],
  ...types: string[]
): z.infer<typeof addressComponentSchema> | undefined {
  return components.find((c) => types.some((t) => c.types?.includes(t)));
}

/**
 * One Text Search lookup. Returns null when no key is configured, when the
 * request fails, or when nothing matched — the caller keeps the typed text
 * either way, so a failure here can only resolve less, never resolve wrong.
 */
export async function searchPlace(query: string): Promise<PlaceMatch | null> {
  const key = placesApiKey();
  const trimmed = query.trim();
  if (!key || !trimmed) return null;
  try {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: trimmed, maxResultCount: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // Status only, never the body or the key: a key that is set but not
      // enabled for Places API (New), or a quota overrun, would otherwise
      // show up only as "couldn't find that place".
      console.warn(`[places] Text Search answered HTTP ${res.status}`);
      return null;
    }
    const parsed = searchResponseSchema.safeParse(
      await res.json().catch(() => null),
    );
    if (!parsed.success) return null;
    const hit = parsed.data.places?.[0];
    if (!hit?.location) return null;
    const components = hit.addressComponents ?? [];
    const street = [
      component(components, "street_number")?.longText ?? "",
      component(components, "route")?.longText ?? "",
    ]
      .join(" ")
      .trim();
    return {
      name: hit.displayName?.text ?? "",
      street,
      city:
        component(
          components,
          "locality",
          "postal_town",
          "administrative_area_level_2",
        )?.longText ?? "",
      // Short form ("CA", "NSW"): the address rule abbreviates the state and
      // the locality hint for the next stop is built from the same string.
      state:
        component(components, "administrative_area_level_1")?.shortText ??
        component(components, "administrative_area_level_1")?.longText ??
        "",
      country: component(components, "country")?.longText ?? "",
      lat: hit.location.latitude,
      lng: hit.location.longitude,
      formattedAddress: hit.formattedAddress ?? trimmed,
    };
  } catch {
    return null;
  }
}
