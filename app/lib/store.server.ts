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

// The full store API — every function in database.ts, re-exported so routes
// import from here (the storage entry point) rather than the backend.
export {
  initStore,
  readAccount,
  createAccount,
  findAccountByInviteCode,
  regenerateInviteCode,
  createUser,
  findUserByEmail,
  findUserById,
  getPasswordHash,
  readExpenses,
  readExpense,
  upsertExpense,
  deleteExpense,
  readPriorMerchants,
  readMerchantCategories,
  readExtractionContext,
  findOpenReport,
  readReports,
  readReportCounts,
  reportExists,
  type ReportSummary,
  readReportSummaries,
  readCategoryCounts,
  addReport,
  removeReport,
  renameReport,
  setReportClosed,
  readCategories,
  addCategory,
  removeCategory,
  renameCategory,
  readSettings,
  writeSettings,
  readMileageRates,
  dismissDuplicatePair,
  readInboundEmail,
  upsertInboundEmail,
  findVerifiedSenderAccount,
  findPendingSenderRow,
  listInboundSenders,
  addInboundSender,
  resendInboundSenderVerification,
  removeInboundSender,
  verifyInboundSenderAddress,
  ensureInboundSenderForUser,
  readBootstrapUser,
  registerOAuthClient,
  findOAuthClient,
  saveOAuthConsent,
  hasOAuthConsent,
  createOAuthCode,
  consumeOAuthCode,
  createOAuthToken,
  findOAuthToken,
  revokeOAuthToken,
  listUserOAuthSessions,
  disconnectOAuthClient,
  deleteOAuthClient,
} from "~/lib/database";

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
    mileageType: "business",
    locations: [],
    distanceMiles: "",
    route: EMPTY_ROUTE,
  };
  return mileage;
}
