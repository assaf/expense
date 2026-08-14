import prisma from "~/lib/prisma.server";
import { normalizeMerchant } from "~/lib/duplicates";
import { deleteImage } from "~/lib/images.server";
import { isMileageType } from "~/lib/mileage-rates";
import {
  EMPTY_ROUTE,
  parseLocations,
  parseRoute,
  type Expense,
  type Location,
  type MileageExpense,
  type ReceiptExpense,
} from "~/lib/types";
import type { Prisma } from "prisma/generated";

// --- Expenses --------------------------------------------------------------

export async function readExpenses(accountId: string): Promise<Expense[]> {
  const rows = await prisma.expense.findMany({ where: { accountId } });
  return rows.map(rowToExpense);
}

export async function readExpense(
  id: string,
  accountId: string,
): Promise<Expense | undefined> {
  const row = await prisma.expense.findFirst({
    where: { id, accountId },
  });
  return row ? rowToExpense(row) : undefined;
}

/**
 * The two expenses immediately before and after `expense` in the main list
 * sort order (dated newest-first, undated newest-createdAt last). Two
 * lightweight queries instead of loading every expense just for prev/next
 * arrows.
 */
export async function readNeighborIds(
  accountId: string,
  expense: { id: string; date: string; createdAt: string },
): Promise<{ prevId: string | null; nextId: string | null }> {
  const hasDate = expense.date !== "";
  let prevId: string | null = null;
  let nextId: string | null = null;

  if (hasDate) {
    // Prev: the expense with the closest *newer* date (date > this one,
    // ordered ascending — the smallest gap forward in time = the one just
    // before in a newest-first list).
    const prev = await prisma.expense.findFirst({
      where: {
        accountId,
        date: { gt: expense.date },
        id: { not: expense.id },
      },
      orderBy: { date: "asc" },
      select: { id: true },
    });
    prevId = prev?.id ?? null;

    // Next: the expense with the closest *older* date (date < this one,
    // ordered descending).
    const next = await prisma.expense.findFirst({
      where: {
        accountId,
        date: { lt: expense.date },
        id: { not: expense.id },
      },
      orderBy: { date: "desc" },
      select: { id: true },
    });
    if (next) {
      nextId = next.id;
    } else {
      // No older dated expense — fall back to the first undated row.
      const firstUndated = await prisma.expense.findFirst({
        where: { accountId, date: "", id: { not: expense.id } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      nextId = firstUndated?.id ?? null;
    }
  } else {
    // Undated expense: prev is the closest newer undated, or the oldest
    // dated row when this is the first undated.
    const prevUndated = await prisma.expense.findFirst({
      where: {
        accountId,
        date: "",
        createdAt: { gt: expense.createdAt },
        id: { not: expense.id },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (prevUndated) {
      prevId = prevUndated.id;
    } else {
      const oldestDated = await prisma.expense.findFirst({
        where: { accountId, date: { not: "" }, id: { not: expense.id } },
        orderBy: { date: "asc" },
        select: { id: true },
      });
      prevId = oldestDated?.id ?? null;
    }

    // Next: closest older undated (createdAt < this one, ordered desc).
    const nextUndated = await prisma.expense.findFirst({
      where: {
        accountId,
        date: "",
        createdAt: { lt: expense.createdAt },
        id: { not: expense.id },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    nextId = nextUndated?.id ?? null;
  }

  return { prevId, nextId };
}

/**
 * The only fields required for client-side duplicate detection on the create
 * page — a thin subset of every expense row so the page doesn't load every
 * column just to check whether the draft looks like an existing entry.
 * The returned objects satisfy the Expense interface (unused fields default
 * to empty) so they slot straight into the existing findDuplicates call.
 */
export async function readDuplicateCandidates(
  accountId: string,
): Promise<Expense[]> {
  const rows = await prisma.expense.findMany({
    where: { accountId },
    select: {
      id: true,
      type: true,
      date: true,
      merchant: true,
      amount: true,
      distanceMiles: true,
      locations: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => {
    const base = {
      id: r.id,
      date: r.date,
      report: "",
      category: "",
      description: "",
      amount: r.amount?.toString() ?? "",
      reconciledAt: "",
      createdAt: String(r.createdAt),
      updatedAt: String(r.createdAt),
    };
    if (r.type === "receipt") {
      return {
        ...base,
        type: "receipt" as const,
        merchant: r.merchant,
        imageFile: "",
        imageMime: "",
        originalName: "",
      };
    }
    return {
      ...base,
      type: "mileage" as const,
      mileageType: "business" as const,
      locations:
        typeof r.locations === "string"
          ? (JSON.parse(r.locations) as Location[])
          : ((r.locations as unknown as Location[]) ?? []),
      distanceMiles: r.distanceMiles?.toString() ?? "",
      route: EMPTY_ROUTE,
    };
  });
}

export async function upsertExpense(
  expense: Expense,
  accountId: string,
): Promise<void> {
  // Targeted row write: one UPDATE when the expense already exists, one
  // INSERT when it doesn't. The row's id is a client-generated ulid, so an
  // account-scoped update that hits nothing means "new expense" — never a
  // takeover of another account's row (that would be a unique-id conflict
  // on create, exactly like the old whole-table rewrite).
  const data = { ...expenseData(expense), accountId };
  const updated = await prisma.expense.updateMany({
    where: { id: expense.id, accountId },
    data: expenseData(expense),
  });
  if (updated.count === 0) {
    await prisma.expense.create({ data });
  }
}

export async function deleteExpense(
  id: string,
  accountId: string,
): Promise<void> {
  const target = await prisma.expense.findFirst({
    where: { id, accountId },
    select: { type: true, imageFile: true },
  });
  if (target) await deleteReceiptImages(accountId, [target]);
  await prisma.expense.deleteMany({ where: { id, accountId } });
}

/** Distinct merchant names previously used, most-recent first. */
export async function readPriorMerchants(accountId: string): Promise<string[]> {
  const grouped = await prisma.expense.groupBy({
    by: ["merchant"],
    where: { accountId, type: "receipt", merchant: { not: "" } },
    _max: { createdAt: true },
  });
  return grouped
    .sort((a, b) =>
      (b._max.createdAt ?? "").localeCompare(a._max.createdAt ?? ""),
    )
    .map((g) => g.merchant);
}

const NINETY_DAYS_MS = 90 * 24 * 3600 * 1000;

/** The date 90 days ago as an ISO string — used as the lower bound for
 * merchant-history lookups. Computed once per call so tests can advance time
 * without restarting. */
function ninetyDaysAgo(): string {
  return new Date(Date.now() - NINETY_DAYS_MS).toISOString();
}

/**
 * The value of one field (category or report) from the most recent receipt
 * per merchant, keyed by the normalized merchant name (same normalization
 * as duplicate detection, so "Blue Bottle" and "blue  bottle" are the same
 * merchant). Only merchants with a non-empty value for the field appear;
 * when a merchant has expenses with different values, the newest wins.
 * Shared by the category and report lookups below, which differ only in
 * which field they read.
 */
async function readLatestMerchantField(
  accountId: string,
  field: "category" | "report",
): Promise<Map<string, string>> {
  // Two typed queries (Prisma can't take a computed column name); each
  // branch normalizes its rows to the same { merchant, createdAt, value }
  // shape so the newest-wins loop below is written once.
  const rows: Array<{ merchant: string; createdAt: string; value: string }> =
    field === "category"
      ? (
          await prisma.expense.findMany({
            where: {
              accountId,
              type: "receipt",
              merchant: { not: "" },
              category: { not: "" },
              createdAt: { gte: ninetyDaysAgo() },
            },
            select: { merchant: true, category: true, createdAt: true },
          })
        ).map((r) => ({
          merchant: r.merchant,
          createdAt: r.createdAt,
          value: r.category,
        }))
      : (
          await prisma.expense.findMany({
            where: {
              accountId,
              type: "receipt",
              merchant: { not: "" },
              report: { not: "" },
              createdAt: { gte: ninetyDaysAgo() },
            },
            select: { merchant: true, report: true, createdAt: true },
          })
        ).map((r) => ({
          merchant: r.merchant,
          createdAt: r.createdAt,
          value: r.report,
        }));
  const latest = new Map<string, { value: string; createdAt: string }>();
  for (const row of rows) {
    const key = normalizeMerchant(row.merchant);
    if (!key) continue;
    const prev = latest.get(key);
    if (!prev || row.createdAt > prev.createdAt) {
      latest.set(key, { value: row.value, createdAt: row.createdAt });
    }
  }
  const byMerchant = new Map<string, string>();
  for (const [key, value] of latest) byMerchant.set(key, value.value);
  return byMerchant;
}

/**
 * The most recent category each merchant was filed under (last 90 days).
 * Used when a new receipt's merchant matches a previous one — the category
 * is reused instead of guessed.
 */
export function readMerchantCategories(
  accountId: string,
): Promise<Map<string, string>> {
  return readLatestMerchantField(accountId, "category");
}

/**
 * The report of the most recent receipt per merchant (last 90 days), so a
 * receipt from a known merchant inherits both category and report.
 */
export function readMerchantReports(
  accountId: string,
): Promise<Map<string, string>> {
  return readLatestMerchantField(accountId, "report");
}

// --- Shared expense serialization (used by the reconcile module too) --------

/** Delete the stored images of receipt expenses, best-effort (image rows
 * may already be gone). Used when expenses are deleted wholesale. */
export async function deleteReceiptImages(
  accountId: string,
  expenses: readonly { type: string; imageFile?: string }[],
): Promise<void> {
  for (const e of expenses) {
    if (e.type === "receipt" && e.imageFile) {
      await deleteImage(accountId, e.imageFile).catch(() => {});
    }
  }
}

/** Expense fields for create/update, split by type. */
export function expenseData(
  e: Expense,
): Omit<Prisma.ExpenseCreateManyInput, "accountId"> {
  const common = {
    id: e.id,
    type: e.type,
    date: e.date,
    report: e.report,
    category: e.category,
    description: e.description,
    // "" is the domain's "no amount" sentinel → NULL (nullable Decimal).
    amount: e.amount === "" ? null : e.amount,
    mileageType: e.type === "mileage" ? e.mileageType : "business",
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    // reconciledAt / reconciledInRunId are deliberately absent: they are
    // managed ONLY by the reconciliation flow. A normal save never writes
    // them, so editing an expense can't wipe its reconciled status.
  };
  if (e.type === "receipt") {
    return {
      ...common,
      merchant: e.merchant,
      imageFile: e.imageFile,
      imageMime: e.imageMime,
      originalName: e.originalName,
      distanceMiles: null,
      locations: [],
      route: undefined,
    };
  }
  return {
    ...common,
    merchant: "",
    imageFile: "",
    imageMime: "",
    originalName: "",
    distanceMiles: e.distanceMiles === "" ? null : e.distanceMiles,
    locations: e.locations as unknown as Prisma.InputJsonValue,
    route: e.route as unknown as Prisma.InputJsonValue,
  };
}

function rowToExpense(row: {
  id: string;
  type: string;
  date: string;
  report: string;
  category: string;
  description: string;
  amount: Prisma.Decimal | null;
  merchant: string;
  imageFile: string;
  imageMime: string;
  originalName: string;
  distanceMiles: Prisma.Decimal | null;
  mileageType: string;
  locations: unknown;
  route: unknown;
  reconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
}): Expense {
  const base = {
    id: row.id,
    type: row.type as Expense["type"],
    date: row.date ?? "",
    report: row.report ?? "",
    category: row.category ?? "",
    description: row.description ?? "",
    // Decimal → 2-dp string (the domain's "" means no amount). toFixed(2) is
    // a lossless pad: numeric(10,2) already stores exactly two digits.
    amount: row.amount?.toFixed(2) ?? "",
    reconciledAt: row.reconciledAt ?? "",
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
  if (base.type === "receipt") {
    const receipt: ReceiptExpense = {
      ...base,
      type: "receipt",
      merchant: row.merchant ?? "",
      imageFile: row.imageFile ?? "",
      imageMime: row.imageMime ?? "",
      originalName: row.originalName ?? "",
    };
    return receipt;
  }
  const mileage: MileageExpense = {
    ...base,
    type: "mileage",
    // Legacy rows predate the type column — they are business trips.
    mileageType: isMileageType(row.mileageType) ? row.mileageType : "business",
    locations: parseLocations(row.locations),
    distanceMiles: row.distanceMiles?.toFixed(2) ?? "",
    route: parseRoute(row.route),
  };
  return mileage;
}
