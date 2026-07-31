/**
 * Domain model for the expense tracker.
 *
 * State is persisted either as CSV files on disk (local dev/tests) or in
 * Postgres with receipt images in Vercel Blob (production) — see
 * store.server.ts. These types describe the in-memory shape after parsing.
 */

export type ExpenseType = "receipt" | "mileage";

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

export interface Report {
  name: string;
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
