import { ulid } from "ulid";
import { hasDatabase } from "~/lib/env";
import { deleteImage } from "~/lib/images.server";
import type { Expense, MileageExpense, ReceiptExpense } from "~/lib/types";
import * as localStore from "~/lib/store/local.server";
import * as pgStore from "~/lib/store/pg.server";

/**
 * Storage facade. Routes every read/write to the Postgres backend when
 * DATABASE_URL is set (Vercel/Coolify production), otherwise falls back to
 * the file-based CSV store (local dev and tests). The two backends share the
 * same behavior and public API; nothing else in the app picks a backend.
 */

const store = hasDatabase() ? pgStore : localStore;

export const initStore = store.initStore;
export const readExpenses = store.readExpenses;
export const readExpense = store.readExpense;
export const writeExpenses = store.writeExpenses;
export const upsertExpense = store.upsertExpense;
export const deleteExpense = store.deleteExpense;
export const readPriorMerchants = store.readPriorMerchants;
export const readReports = store.readReports;
export const writeReports = store.writeReports;
export const addReport = store.addReport;
export const removeReport = store.removeReport;
export const renameReport = store.renameReport;
export const readCategories = store.readCategories;
export const writeCategories = store.writeCategories;
export const addCategory = store.addCategory;
export const removeCategory = store.removeCategory;
export const readSettings = store.readSettings;
export const writeSettings = store.writeSettings;

/** Delete a stored image through the active image backend. */
export function deleteImageFile(filename: string): Promise<void> {
  return deleteImage(filename);
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
    locations: [],
    distanceMiles: "",
  };
  return mileage;
}
