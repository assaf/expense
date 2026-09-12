import { ulid } from "ulid";
import { db } from "~/lib/prisma.server";
import { isUniqueViolation } from "~/lib/db/pg-errors";
import { bust, cachedRead, createCache } from "~/lib/db/shared";
import { fromIso } from "~/lib/db/wire";
import {
  HOME_NAME,
  isValidCoords,
  MAX_ADDRESS_LENGTH,
  type NamedLocation,
} from "~/lib/types";

/**
 * The account's named places ("Work", "Hospital", "Restaurant"): what a
 * mileage trip is authored from by name, and what the insights chat
 * resolves a stop name to.
 *
 * Home is deliberately not a row here. It is the fixed first and last stop
 * of every trip, so it lives in the settings key/value rows instead
 * (readSettings); that is also what makes "there is always at least one
 * location, and home can't be deleted" a property of the schema rather than
 * a rule some caller has to remember.
 */

/** Longest name stored: it reaches the insights prompt and comes from a
 * form, so bound it at the ingress. */
const MAX_NAME_LENGTH = 60;

/** Per-account cache for the named locations, same 5-minute TTL as
 * categories and reports. */
const locationsCache = createCache<NamedLocation[]>(300_000);

function locationFromRow(row: {
  id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
}): NamedLocation {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
  };
}

/** The account's named locations, alphabetical (case-insensitive) by name. */
export async function readLocations(
  accountId: string,
): Promise<NamedLocation[]> {
  return cachedRead(locationsCache, accountId, async () => {
    const rows = await db.orm.public.Location.where((l) =>
      l.accountId.eq(accountId),
    ).all();
    return rows
      .map(locationFromRow)
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
  });
}

/** The values a named location is created or edited with. */
export interface LocationInput {
  name: string;
  address: string;
  /** Geocoder coordinates for the address; null when it did not resolve. */
  lat: number | null;
  lng: number | null;
}

/** The saved location, or why it could not be saved. */
export type LocationResult =
  | { ok: true; location: NamedLocation }
  | { ok: false; error: string };

/** Coordinates are a pair: a lone lat or lng is meaningless, and both are
 * range-checked so a bad geocoder value can never be stored. */
function coords(input: LocationInput): {
  lat: number | null;
  lng: number | null;
} {
  const { lat, lng } = input;
  if (!isValidCoords(lat, lng)) return { lat: null, lng: null };
  return { lat, lng };
}

/** Bound an address to what the app stores and sends to the geocoder. The
 * form's value reaches an outbound query, so the ingress clamps it before
 * geocoding rather than only on the way into the row. */
export function boundAddress(address: string): string {
  return address.trim().slice(0, MAX_ADDRESS_LENGTH);
}

/** Trim + validate the user's input. Returns the error message, or the
 * cleaned fields. */
function clean(
  input: LocationInput,
): { error: string } | { name: string; address: string } {
  const name = input.name.trim().slice(0, MAX_NAME_LENGTH);
  const address = boundAddress(input.address);
  if (!name) return { error: "Name can't be empty." };
  if (name.toLowerCase() === HOME_NAME.toLowerCase()) {
    return {
      error: `"${HOME_NAME}" is the start and end of every trip, so it can't be a named location.`,
    };
  }
  if (!address) return { error: "Address can't be empty." };
  return { name, address };
}

/** True when another location already uses this name (case-insensitive):
 * names are how a trip and the chat refer to a place, so two spellings of
 * one name would be ambiguous. */
async function nameTaken(
  accountId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const locations = await readLocations(accountId);
  return locations.some(
    (l) => l.id !== exceptId && l.name.toLowerCase() === name.toLowerCase(),
  );
}

/** Save a new named location. */
export async function addLocation(
  accountId: string,
  input: LocationInput,
): Promise<LocationResult> {
  const cleaned = clean(input);
  if ("error" in cleaned) return { ok: false, error: cleaned.error };
  if (await nameTaken(accountId, cleaned.name)) {
    return {
      ok: false,
      error: `A location named "${cleaned.name}" already exists.`,
    };
  }
  const now = new Date().toISOString();
  const location: NamedLocation = {
    id: ulid(),
    ...cleaned,
    ...coords(input),
  };
  try {
    await db.orm.public.Location.create({
      ...location,
      accountId,
      createdAt: fromIso(now),
      updatedAt: fromIso(now),
    });
  } catch (err) {
    // The unique (accountId, name) index is the real guard: two concurrent
    // adds race past the read above.
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: `A location named "${cleaned.name}" already exists.`,
      };
    }
    throw err;
  }
  bust(locationsCache, accountId);
  return { ok: true, location };
}

/** Rename a named location and/or change its address. */
export async function updateLocation(
  accountId: string,
  id: string,
  input: LocationInput,
): Promise<LocationResult> {
  const cleaned = clean(input);
  if ("error" in cleaned) return { ok: false, error: cleaned.error };
  if (await nameTaken(accountId, cleaned.name, id)) {
    return {
      ok: false,
      error: `A location named "${cleaned.name}" already exists.`,
    };
  }
  let rows: { id: string }[] = [];
  try {
    rows = await db.orm.public.Location.where({
      accountId,
      id,
    }).updateAll({
      ...cleaned,
      ...coords(input),
      updatedAt: fromIso(new Date().toISOString()),
    });
  } catch (err) {
    // The name pre-check raced another rename to the same name: report the
    // same message instead of leaking the unique violation.
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: `A location named "${cleaned.name}" already exists.`,
      };
    }
    throw err;
  }
  if (rows.length === 0) {
    return { ok: false, error: "That location no longer exists." };
  }
  bust(locationsCache, accountId);
  return {
    ok: true,
    location: { id, ...cleaned, ...coords(input) },
  };
}

/** Delete a named location. Expenses keep the addresses they were saved
 * with, so a removed place only disappears from the pickers. */
export async function removeLocation(
  accountId: string,
  id: string,
): Promise<void> {
  await db.orm.public.Location.where({ accountId, id }).deleteAll();
  bust(locationsCache, accountId);
}
