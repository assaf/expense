/**
 * Domain model for the expense tracker.
 *
 * State is persisted in Postgres (see database.ts) with receipt images in
 * Vercel Blob or Postgres BYTEA (see images.server.ts). These types describe
 * the in-memory shape after parsing.
 */

type ExpenseType = "receipt" | "mileage";

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
  locations: Location[];
  distanceMiles: string; // decimal string "122.13", "" when unset
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
  /** Login name, unique, stored lowercase. */
  username: string;
  /** Display name (optional). */
  name: string;
  createdAt: string;
}

/** Settings stored as key/value rows (settings.csv locally, a settings table in Postgres). */
export type Settings = {
  /** Home location used as the first/last stop of every mileage route. */
  homeAddress: string;
  homeLat: number | null;
  homeLng: number | null;
  /** Mileage reimbursement rate per calendar year, e.g. { "2026": "0.70" }. */
  mileageRates: Record<string, string>;
};

export const DEFAULT_SETTINGS: Settings = {
  homeAddress: "",
  homeLat: null,
  homeLng: null,
  mileageRates: {},
};

/**
 * Default categories seeded for every new account. These mirror the expense
 * categories on IRS Schedule C (Form 1040), Part II, lines 8–27a, so
 * receipts can be tagged with the same buckets used on the tax return.
 * Users can rename, add, or remove categories later in Settings.
 */
export const DEFAULT_CATEGORIES: string[] = [
  "Advertising",
  "Car and truck expenses",
  "Commissions and fees",
  "Contract labor",
  "Depletion",
  "Depreciation and section 179 expense deduction",
  "Employee benefit programs",
  "Insurance (other than health)",
  "Mortgage interest paid to banks, etc.",
  "Other interest",
  "Legal and professional services",
  "Office expenses",
  "Pension and profit-sharing plans",
  "Rent or lease: vehicles, machinery, and equipment",
  "Rent or lease: other business property",
  "Repairs and maintenance",
  "Supplies",
  "Taxes and licenses",
  "Travel",
  "Meals and entertainment",
  "Utilities",
  "Wages",
  "Other expenses",
];

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
