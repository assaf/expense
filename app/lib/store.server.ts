import { ulid } from "ulid";
import { hasDatabase } from "~/lib/env";
import { deleteImage } from "~/lib/images.server";
import type { Expense, MileageExpense, ReceiptExpense } from "~/lib/types";
import * as pgStore from "~/lib/store/pg.server";

/**
 * Storage entry point. Postgres is required — every read/write goes through
 * pg.server.ts and the app refuses to start without DATABASE_URL (there is no
 * file fallback anymore). Image storage is selected separately in
 * images.server.ts (Vercel Blob vs Postgres BYTEA, no local fallback).
 */
if (!hasDatabase()) {
  throw new Error(
    "DATABASE_URL is required — set it in .env for local dev, or in the Vercel/Coolify dashboard for production.",
  );
}

const store = pgStore;

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
