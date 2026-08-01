import { ulid } from "ulid";
import { hasDatabase } from "~/lib/env";
import type { Expense, MileageExpense, ReceiptExpense } from "~/lib/types";
import * as db from "~/lib/database";

/**
 * Storage entry point. Postgres is required — every read/write goes through
 * database.ts and the app refuses to start without DATABASE_URL (there is no
 * file fallback anymore). Image storage is selected separately in
 * images.server.ts (Vercel Blob vs Postgres BYTEA, no local fallback).
 *
 * Every function is scoped by accountId — the caller passes the logged-in
 * user's account and only that account's rows are touched.
 */
if (!hasDatabase()) {
  throw new Error(
    "DATABASE_URL is required — set it in .env for local dev, or in the Vercel/Coolify dashboard for production.",
  );
}

const store = db;

export const initStore = store.initStore;
export const readAccount = store.readAccount;
export const createAccount = store.createAccount;
export const findAccountByInviteCode = store.findAccountByInviteCode;
export const regenerateInviteCode = store.regenerateInviteCode;
export const createUser = store.createUser;
export const findUserByUsername = store.findUserByUsername;
export const findUserById = store.findUserById;
export const getPasswordHash = store.getPasswordHash;
export const readExpenses = store.readExpenses;
export const readExpense = store.readExpense;
export const upsertExpense = store.upsertExpense;
export const deleteExpense = store.deleteExpense;
export const readPriorMerchants = store.readPriorMerchants;
export const readReports = store.readReports;
export const readReportCounts = store.readReportCounts;
export const readCategoryCounts = store.readCategoryCounts;
export const addReport = store.addReport;
export const removeReport = store.removeReport;
export const renameReport = store.renameReport;
export const setReportClosed = store.setReportClosed;
export const readCategories = store.readCategories;
export const addCategory = store.addCategory;
export const removeCategory = store.removeCategory;
export const renameCategory = store.renameCategory;
export const readSettings = store.readSettings;
export const writeSettings = store.writeSettings;
export const readInboundEmail = store.readInboundEmail;
export const upsertInboundEmail = store.upsertInboundEmail;
export const findAccountByInboundSender = store.findAccountByInboundSender;
export const listInboundSenders = store.listInboundSenders;
export const addInboundSender = store.addInboundSender;
export const removeInboundSender = store.removeInboundSender;

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
