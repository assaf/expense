/**
 * Domain model for the expense tracker.
 *
 * State is persisted in Postgres (see database.ts) with receipt images in
 * Postgres BYTEA (see images.server.ts). These types describe the
 * in-memory shape after parsing.
 */

import { ulid } from "ulid";

type ExpenseType = "receipt" | "mileage";

/** IRS reimbursement type for a mileage expense; determines the rate
 * (with the trip date) from the global mileage_rates master table. */
export type MileageType = "business" | "charity" | "medical" | "moving";

/** A single geocoded address used in a mileage route. */
export interface Location {
  address: string;
  lat: number | null;
  lng: number | null;
}

/**
 * A place the account drives to, saved under a name ("Work", "Hospital",
 * "Restaurant") so a trip can be authored by name instead of by address.
 * The home location is deliberately NOT one of these: it is the fixed
 * start and end of every trip and lives in Settings.
 */
export interface NamedLocation {
  id: string;
  /** Display name, unique per account (case-insensitively). */
  name: string;
  /** The address as saved; the coordinates are what a stop uses. */
  address: string;
  lat: number | null;
  lng: number | null;
}

/** The name the home location goes by. Home is not a named location (see
 * NamedLocation), so this is both its display name and the name a named
 * location may not take. Lives here, not with the locations table, because
 * the editor renders it client-side and the db module reaches Prisma. */
export const HOME_NAME = "Home";

/** Fields common to every expense. */
interface ExpenseBase {
  id: string;
  type: ExpenseType;
  date: string; // YYYY-MM-DD, "" when unset
  report: string; // report name, "" when unset
  category: string; // tax category name, "" when unset
  description: string;
  amount: string; // decimal string "12.34", "" when unset
  /** When this expense was reconciled against a credit card statement
   * (see ReconciliationRun); ISO timestamp, "" when not reconciled.
   * Set only by the reconciliation flow, never by a normal save. */
  reconciledAt: string;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

export interface ReceiptExpense extends ExpenseBase {
  type: "receipt";
  merchant: string;
  imageFile: string; // storage key (bare filename, or `images/...` blob pathname)
  imageMime: string;
  originalName: string;
  /** SHA-256 hex of the stored image bytes, "" when none or a legacy row.
   * The duplicate-detection fingerprint: same bytes = same receipt image,
   * whatever route it arrived by. */
  imageSha256: string;
  /** ISO 4217 code of the currency the receipt was issued in, uppercased.
   * "USD" for dollar receipts, legacy rows, and mileage expenses. When it
   * isn't USD, `amount` is the USD conversion (ECB reference rate for the
   * expense date) and `originalAmount`/`fxRate` record the conversion. */
  currency: string;
  /** The amount as printed on the receipt, in `currency` ("" when the
   * receipt is USD or legacy). The USD value lives in `amount`. */
  originalAmount: string;
  /** USD per 1 unit of `currency`, as used for the conversion; "" when no
   * conversion happened (USD receipt, legacy row, or no rate was found). */
  fxRate: string;
}

export interface MileageExpense extends ExpenseBase {
  type: "mileage";
  /** IRS reimbursement type; the rate is looked up from the global
   * mileage_rates master table by (date, type). Defaults to "business". */
  mileageType: MileageType;
  locations: Location[];
  distanceMiles: string; // decimal string "122.13", "" when unset
  /** True when the trip returns to its first stop (the closed loop every
   * trip used to assume), false for a one-way drive that ends at its last
   * stop. Trips filed before one-way existed are round trips. */
  roundTrip: boolean;
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

/** What a chat proposal card can be: a mileage trip or a typed purchase.
 * The stored exchange and the client both need to name it (to label the
 * review link), so the union lives here rather than being spelled out at
 * every declaration. */
export type ProposalKind = "mileage" | "expense";

/** Runtime counterpart of ProposalKind, for values read back out of jsonb. */
export function isProposalKind(value: unknown): value is ProposalKind {
  return value === "mileage" || value === "expense";
}

/** The longest address the app stores and sends to the geocoder, shared by
 * the client (input caps) and the server (the stored column and the
 * outbound query string). */
export const MAX_ADDRESS_LENGTH = 300;

/** A usable coordinate pair: both finite and inside the globe. A lone value,
 * NaN/Infinity (a caller can send either as JSON), or an out-of-range point
 * is not a location the router can use, so it is dropped rather than stored
 * and later fed to the distance math. */
export function isValidCoords(lat: number | null, lng: number | null): boolean {
  return (
    lat !== null &&
    lng !== null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

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
      .map((v) => {
        const lat = typeof v.lat === "number" ? v.lat : null;
        const lng = typeof v.lng === "number" ? v.lng : null;
        return {
          address: typeof v.address === "string" ? v.address : "",
          ...(isValidCoords(lat, lng)
            ? { lat, lng }
            : { lat: null, lng: null }),
        };
      });
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
  /** True once the report is closed. Closing freezes it; deleting a closed
   *  report (or one with several expenses) requires explicit confirmation. */
  closed: boolean;
  /** ISO timestamp of creation; null for reports that predate the column. */
  createdAt: string | null;
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
  /** Billing tier: "paid" or "gratis" unlock conversational AI
   * (insights); null = no plan yet, AI surfaces show an upgrade prompt. */
  plan: string | null;
  createdAt: string;
}

/** A login identity, always linked to exactly one account. */
export interface User {
  id: string;
  accountId: string;
  /** Login name: the email address, stored lowercase. */
  email: string;
  /** When the email was verified (the emailed link was clicked); null means
   * the account can't sign in until it is. */
  emailVerifiedAt: string | null;
  /** When the password last changed (a reset); null when it never has. A
   * session or OAuth token minted before this moment is refused. */
  credentialsChangedAt: string | null;
  createdAt: string;
}

/** Settings stored as key/value rows in Postgres (a settings table).
 * Mileage rates are NOT here; they live in the global mileage_rates master table. */
export type Settings = {
  /** Home location used as the first/last stop of every mileage route. It
   * is the one location that can never be removed; the account's other
   * named places live in the locations table (app/lib/db/locations.ts). */
  homeAddress: string;
  homeLat: number | null;
  homeLng: number | null;
  /** True when the account completed Fastmail onboarding and hasn't
   * dismissed the welcome panel yet; the ONLY accounts that see the
   * panel are the ones the onboarding flow explicitly flags (the default
   * is hidden, so email-signup accounts never see it). */
  welcomePending: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  homeAddress: "",
  homeLat: null,
  homeLng: null,
  welcomePending: false,
};

/** The configured home location (used as first/last stop of mileage routes). */
export function homeLocation(settings: Settings): Location {
  return {
    address: settings.homeAddress,
    lat: settings.homeLat,
    lng: settings.homeLng,
  };
}

/** Build a new expense shell with sensible defaults. */
export function newExpenseShell(type: Expense["type"]): Expense {
  const now = new Date().toISOString();
  const base = {
    id: ulid(),
    date: "",
    report: "",
    category: "",
    description: "",
    amount: "",
    reconciledAt: "",
    createdAt: now,
    updatedAt: now,
  };
  if (type === "receipt") {
    const receipt: ReceiptExpense = {
      ...base,
      type: "receipt",
      merchant: "",
      imageFile: "",
      imageMime: "",
      originalName: "",
      imageSha256: "",
      currency: "USD",
      originalAmount: "",
      fxRate: "",
    };
    return receipt;
  }
  const mileage: MileageExpense = {
    ...base,
    type: "mileage",
    mileageType: "business",
    locations: [],
    distanceMiles: "",
    // A new trip is the drive the user describes: one way, unless the
    // editor's round trip box says it returns to its first stop.
    roundTrip: false,
    route: EMPTY_ROUTE,
  };
  return mileage;
}

/** One processed inbound email (idempotency + audit). */ export interface InboundEmailRecord {
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

/** A connected email account (auto-import). Never carries the API token. */
export interface EmailConnectionRecord {
  id: string;
  accountId: string;
  /** "fastmail" means JMAP. More providers later (Gmail, …). */
  provider: string;
  emailAddress: string;
  /** "active" | "error" (renewal failures flag the row for Settings). */
  status: string;
  receivedCount: number;
  processedCount: number;
  lastPushAt: string | null;
  pushSubscriptionId: string | null;
  pushExpiresAt: string | null;
  /** Last inbox review scan stamp (/email-review). */
  reviewScannedAt: string | null;
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
  /** The rotation family this token belongs to (null on legacy rows). */
  familyId: string | null;
}

// --- Reconciliation --------------------------------------------------------

/** One parsed transaction line from a statement file. The amount is stored
 * absolute; the sign is carried by `direction` so a Chase-style signed CSV
 * and a Citi-style Debit/Credit split normalize to the same shape. */
export interface StatementRow {
  /** 0-based index within the statement (the run's row key). */
  index: number;
  date: string; // YYYY-MM-DD
  description: string;
  /** Absolute amount, decimal string "12.34". */
  amount: string;
  /** charge = a purchase (matchable); refund = a credit/refund/payment. */
  direction: "charge" | "refund";
  /** Bank transaction id (QFX/OFX FITID) when the file provides one. */
  fitId?: string;
  source: "csv" | "ofx" | "xlsx" | "pdf";
  /** Original row/line text, for display in the skipped report. */
  raw: string;
}

/** A statement line the parser could not turn into a transaction. */
export interface SkippedLine {
  line: number;
  raw: string;
  reason: string;
}

/** One candidate expense for a statement row. */
export interface MatchCandidate {
  expenseId: string;
  merchant: string;
  date: string;
  amount: string;
  exactDate: boolean;
  exactAmount: boolean;
  merchantOverlap: boolean;
}

/** The matcher's verdict for one statement row. */
export type RowMatch =
  | {
      status: "matched";
      expenseId: string;
      confidence: "high";
      candidate: MatchCandidate;
    }
  | {
      status: "review";
      candidates: MatchCandidate[];
      best: MatchCandidate | null;
      reasons: string[];
    }
  | { status: "unmatched" };

/** The user's decision for one statement row; overrides the auto match.
 * No decision on a `matched` row means "keep the auto match"; no decision
 * on any other row means the line is discarded at completion. */
export type ReconciliationDecision =
  | { kind: "match"; expenseId: string }
  | { kind: "new"; draft: NewExpenseDraft };

/** A new expense drafted from a statement row (created at completion). */
export interface NewExpenseDraft {
  date: string;
  merchant: string;
  amount: string;
  report: string;
  category: string;
  description: string;
}

/** Working state stored on a reconciliation run (`data` JSON column). */
export interface ReconciliationRunData {
  rows: StatementRow[];
  matches: RowMatch[];
  decisions: Record<string, ReconciliationDecision>;
  /** Filled in when the run completes (summary for the done screen). */
  completed?: {
    matched: number;
    created: number;
    errors: string[];
    createdExpenseIds: string[];
  };
}

/** One uploaded statement (draft | completed | discarded). */
export interface ReconciliationRunRecord {
  id: string;
  accountId: string;
  fileName: string;
  fileHash: string;
  status: "draft" | "completed" | "discarded";
  rowCount: number;
  matchedCount: number;
  createdCount: number;
  skipped: SkippedLine[];
  data: ReconciliationRunData;
  createdAt: string;
  completedAt: string | null;
}
