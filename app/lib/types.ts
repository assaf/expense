/**
 * Domain model for the expense tracker.
 *
 * State is persisted in Postgres (see database.ts) with receipt images in
 * Postgres BYTEA (see images.server.ts). These types describe the
 * in-memory shape after parsing.
 */

type ExpenseType = "receipt" | "mileage";

/** IRS reimbursement type for a mileage expense — determines the rate
 * (with the trip date) from the global mileage_rates master table. */
export type MileageType = "business" | "charity" | "medical" | "moving";

/** A single geocoded address used in a mileage route. */
export interface Location {
  address: string;
  lat: number | null;
  lng: number | null;
}

/** Fields common to every expense. */
interface ExpenseBase {
  id: string;
  type: ExpenseType;
  date: string; // YYYY-MM-DD, "" when unset
  report: string; // report name, "" when unset
  category: string; // tax category name, "" when unset
  description: string;
  amount: string; // decimal string "12.34", "" when unset
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

export interface ReceiptExpense extends ExpenseBase {
  type: "receipt";
  merchant: string;
  imageFile: string; // storage key (bare filename, or `images/...` blob pathname)
  imageMime: string;
  originalName: string;
}

export interface MileageExpense extends ExpenseBase {
  type: "mileage";
  /** IRS reimbursement type — the rate is looked up from the global
   * mileage_rates master table by (date, type). Defaults to "business". */
  mileageType: MileageType;
  locations: Location[];
  distanceMiles: string; // decimal string "122.13", "" when unset
  /** Driving-route geometry persisted with the expense so every map (the
   * list thumbnails and the editor on open) shows the routed trip, not
   * straight point-to-point lines. Empty until a route is computed. */
  route: RouteGeometry;
}

/** Driving-route geometry as [lat, lng] pairs: `coords` is the outbound
 * route (start → last stop), `returnCoords` the last stop → start leg. */
export interface RouteGeometry {
  coords: [number, number][];
  returnCoords: [number, number][];
}

export const EMPTY_ROUTE: RouteGeometry = { coords: [], returnCoords: [] };

/** Parse stored/transmitted route geometry, tolerating malformed or missing
 * data (legacy rows predate the column, so it defaults to empty). */
export function parseRoute(raw: unknown): RouteGeometry {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return EMPTY_ROUTE;
    }
  }
  if (!obj || typeof obj !== "object") return EMPTY_ROUTE;
  const o = obj as { coords?: unknown; returnCoords?: unknown };
  const parsePairs = (v: unknown): [number, number][] => {
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (p): p is [number, number] =>
          Array.isArray(p) &&
          p.length >= 2 &&
          typeof p[0] === "number" &&
          typeof p[1] === "number",
      )
      .map((p) => [p[0], p[1]]);
  };
  return {
    coords: parsePairs(o.coords),
    returnCoords: parsePairs(o.returnCoords),
  };
}

export type Expense = ReceiptExpense | MileageExpense;

/** Parse stored/transmitted location data (JSON array or array) into
 * typed locations, dropping malformed entries. Used for the DB JSON column
 * and for the editor's `locations` form field. */
export function parseLocations(raw: unknown): Location[] {
  if (Array.isArray(raw)) {
    return raw
      .filter(
        (v): v is { address: string; lat: number | null; lng: number | null } =>
          v && typeof v === "object" && "address" in v,
      )
      .map((v) => ({
        address: typeof v.address === "string" ? v.address : "",
        lat: typeof v.lat === "number" ? v.lat : null,
        lng: typeof v.lng === "number" ? v.lng : null,
      }));
  }
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parseLocations(parsed);
  } catch {
    return [];
  }
}

/** Locations that already have coordinates (geocoded so far), narrowed to
 * non-null lat/lng. Used by the map rendering, route computation, and the
 * list thumbnails. */
export function geocodedLocations(
  locations: Location[],
): (Location & { lat: number; lng: number })[] {
  return locations.filter(
    (l): l is Location & { lat: number; lng: number } =>
      l.lat !== null && l.lng !== null,
  );
}

export interface Report {
  name: string;
  /** True once the report is closed — closing freezes it; deleting a closed
   *  report (or one with several expenses) requires explicit confirmation. */
  closed: boolean;
}

export interface Category {
  name: string;
}

/**
 * A shared workspace. Multiple users belong to one account and share its
 * expenses, reports, categories, and settings. New accounts are created at
 * signup; other users join with the account's invite code.
 */
export interface Account {
  id: string;
  /** Unique account name, shown in Settings. */
  name: string;
  /** Secret code used to join the account (regenerable). */
  inviteCode: string;
  createdAt: string;
}

/** A login identity, always linked to exactly one account. */
export interface User {
  id: string;
  accountId: string;
  /** Login name — the email address, stored lowercase. */
  email: string;
  /** When the email was verified (the emailed link was clicked); null means
   * the account can't sign in until it is. */
  emailVerifiedAt: string | null;
  createdAt: string;
}

/** Settings stored as key/value rows in Postgres (a settings table).
 * Mileage rates are NOT here — they live in the global mileage_rates master table. */
export type Settings = {
  /** Home location used as the first/last stop of every mileage route. */
  homeAddress: string;
  homeLat: number | null;
  homeLng: number | null;
};

export const DEFAULT_SETTINGS: Settings = {
  homeAddress: "",
  homeLat: null,
  homeLng: null,
};

/** One processed inbound email (idempotency + audit). */
export interface InboundEmailRecord {
  emailId: string;
  accountId: string;
  subject: string;
  status: "processing" | "created" | "partial" | "error";
  error: string;
  createdAt: string;
  updatedAt: string;
}

/** One receipt-forwarding sender row with its verified status. */
export interface InboundSenderRecord {
  accountId: string;
  address: string;
  /** Verified by clicking the emailed link (see inbound_sender_verifications). */
  verified: boolean;
  verifiedAt: string | null;
  verificationSentAt: string | null;
  createdAt: string;
}

/** An OAuth client registered by an MCP client (RFC 7591 dynamic registration). */
export interface OAuthClientRecord {
  id: string;
  secretHash: string | null;
  name: string;
  redirectUris: string[];
  authMethod: "none" | "client_secret_basic";
  createdAt: string;
}

/** A claimed (single-use) authorization code, returned by consumeOAuthCode. */
export interface OAuthCodeRecord {
  id: string;
  userId: string;
  clientId: string;
  challenge: string;
  redirectUri: string;
  expiresAt: string;
}

/** A stored access or refresh token (hashed at rest, opaque on the wire). */
export interface OAuthTokenRecord {
  tokenHash: string;
  userId: string;
  clientId: string;
  type: "access" | "refresh";
  scope: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}
