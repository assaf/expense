import { ulid } from "ulid";
import { hasDatabase } from "~/lib/env";
import {
  EMPTY_ROUTE,
  type Expense,
  type MileageExpense,
  type ReceiptExpense,
} from "~/lib/types";

/**
 * Storage entry point. Postgres is required — every read/write goes through
 * database.ts and the app refuses to start without DATABASE_URL (there is no
 * file fallback anymore). Receipt images live in Postgres BYTEA
 * (images.server.ts) — no separate storage service.
 *
 * Every function is scoped by accountId — the caller passes the logged-in
 * user's account and only that account's rows are touched.
 */
if (!hasDatabase()) {
  throw new Error(
    "DATABASE_URL is required — set it in .env for local dev, or in the Vercel dashboard for production.",
  );
}

// The full store API — every function in database.ts, re-exported so routes
// import from here (the storage entry point) rather than the backend.
export * from "~/lib/database";

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
    };
    return receipt;
  }
  const mileage: MileageExpense = {
    ...base,
    type: "mileage",
    mileageType: "business",
    locations: [],
    distanceMiles: "",
    route: EMPTY_ROUTE,
  };
  return mileage;
}
