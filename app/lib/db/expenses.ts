import prisma from "~/lib/prisma.server";
import { normalizeMerchant } from "~/lib/duplicates";
import { deleteImage } from "~/lib/images.server";
import { isMileageType } from "~/lib/mileage-rates";
import type { KnownMerchant } from "~/lib/receipt-ai.server";
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

/** Expense row plus its image blob in one round trip, for the image serving
 * route: the home list requests one image per receipt, and two sequential
 * queries per tile (expense, then blob) doubled the DB round trips. The
 * LEFT JOIN is on the expense's namespaced `imageFile` key, so `blobMime` /
 * `blobData` / `thumbnail` are null when the expense has no image (or its
 * blob row is missing); callers 404 on that, same as a null blob read. */
export type ExpenseImageRow = {
  type: string;
  imageFile: string;
  imageMime: string;
  updatedAt: string;
  blobMime: string | null;
  blobData: Uint8Array | null;
  thumbnail: Uint8Array | null;
};

export async function readExpenseImage(
  id: string,
  accountId: string,
): Promise<ExpenseImageRow | undefined> {
  const rows = await prisma.$queryRaw<ExpenseImageRow[]>`
    SELECT e."type", e."imageFile", e."imageMime", e."updatedAt",
           b."mime" AS "blobMime", b."data" AS "blobData", b."thumbnail"
    FROM "expenses" e
    LEFT JOIN "image_blobs" b
      ON b."accountId" = e."accountId" AND b."key" = e."imageFile"
    WHERE e."id" = ${id} AND e."accountId" = ${accountId}
    LIMIT 1
  `;
  return rows[0];
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
    // ordered ascending, so the smallest gap forward in time = the one just
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
      // No older dated expense; fall back to the first undated row.
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
 * page: a thin subset of every expense row so the page doesn't load every
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
      report: true,
      category: true,
      description: true,
      reconciledAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => {
    const base = {
      ...expenseBase(r),
      type: r.type as Expense["type"],
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
      distanceMiles: r.distanceMiles?.toFixed(2) ?? "",
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
  // account-scoped update that hits nothing means "new expense", never a
  // takeover of another account's row (that would be a unique-id conflict
  // on create, exactly like the old whole-table rewrite).
  const data = { ...expenseData(expense), accountId };
  const updated = await prisma.expense.updateMany({
    where: { id: expense.id, accountId },
    data,
  });
  if (updated.count === 0) {
    await prisma.expense.create({ data });
  }
}

/**
 * How long a recently-imported matching expense counts as "the same
 * receipt" for confirmation dedup. Covers the cross-pipeline lag: the
 * connected-account pipeline imports the inbox original within seconds of
 * arrival, while the receipts-by-email pipeline finishes the user's forward
 * minutes later (full OCR/LLM extraction). 30 minutes swallows both with
 * margin without reaching back into unrelated history.
 */
const RECENT_MATCH_WINDOW_MS = 30 * 60 * 1000;

/**
 * A matching receipt expense imported within RECENT_MATCH_WINDOW_MS: the
 * inbox-original / forwarded-copy overlap between the connected-account
 * pipeline and the receipts-by-email pipeline. The same receipt exists as
 * two different emails (different from/to, different mailboxes), so each
 * pipeline imports it independently; the second import's caller suppresses
 * its confirmation so the user gets one response per receipt, not one per
 * pipeline.
 *
 * Key: merchant + amount + date, plus description when the new import
 * carries one (z.ai refs like "#1639-4741" distinguish two same-price
 * receipts that would otherwise collide; charge notifications with an
 * empty description match on the first three fields alone).
 */
export async function findRecentlyImportedMatch(
  accountId: string,
  opts: {
    merchant: string;
    amount: string;
    date: string;
    description: string;
    excludeExpenseId: string;
  },
): Promise<{ id: string; createdAt: string } | undefined> {
  if (!opts.merchant || !opts.amount || !opts.date) return undefined;
  const row = await prisma.expense.findFirst({
    where: {
      accountId,
      type: "receipt",
      id: { not: opts.excludeExpenseId },
      merchant: { equals: opts.merchant, mode: "insensitive" },
      amount: opts.amount,
      date: opts.date,
      createdAt: {
        gte: new Date(Date.now() - RECENT_MATCH_WINDOW_MS).toISOString(),
      },
      ...(opts.description ? { description: opts.description } : {}),
    },
    select: { id: true, createdAt: true },
  });
  return row ? { ...row, createdAt: row.createdAt.toISOString() } : undefined;
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
      (b._max.createdAt?.toISOString() ?? "").localeCompare(
        a._max.createdAt?.toISOString() ?? "",
      ),
    )
    .map((g) => g.merchant);
}

const NINETY_DAYS_MS = 90 * 24 * 3600 * 1000;

/** The date 90 days ago as an ISO string, used as the lower bound for
 * merchant-history lookups. Computed once per call so tests can advance time
 * without restarting. */
function ninetyDaysAgo(): string {
  return new Date(Date.now() - NINETY_DAYS_MS).toISOString();
}

/**
 * Every merchant the account has spent with in the last 90 days: display
 * name plus the most recent category/report per field, keyed by the
 * normalized merchant name (same normalization as duplicate detection, so
 * "Blue Bottle" and "blue  bottle" are the same merchant). When a
 * merchant has expenses with different values, the newest non-empty value
 * per field wins; the display spelling comes from the newest row. Drives
 * the LLM-skip path and the prior category/report lookups.
 */
export async function readKnownMerchants(
  accountId: string,
): Promise<Map<string, KnownMerchant>> {
  const rows = await prisma.expense.findMany({
    where: {
      accountId,
      type: "receipt",
      merchant: { not: "" },
      createdAt: { gte: ninetyDaysAgo() },
    },
    select: { merchant: true, category: true, report: true, createdAt: true },
  });
  const byMerchant = new Map<
    string,
    {
      display: string;
      latestAt: string;
      category: { value: string; at: string } | null;
      report: { value: string; at: string } | null;
    }
  >();
  for (const row of rows) {
    const key = normalizeMerchant(row.merchant);
    if (!key) continue;
    let m = byMerchant.get(key);
    if (!m) {
      m = {
        display: row.merchant.trim(),
        latestAt: row.createdAt.toISOString(),
        category: null,
        report: null,
      };
      byMerchant.set(key, m);
    }
    // Display name: the newest row's spelling wins.
    if (row.createdAt.toISOString() > m.latestAt) {
      m.latestAt = row.createdAt.toISOString();
      m.display = row.merchant.trim();
    }
    // Per-field newest non-empty value wins: a field is inherited from
    // its own newest expense, even when the overall-newest row left it
    // empty.
    if (
      row.category &&
      (!m.category || row.createdAt.toISOString() > m.category.at)
    ) {
      m.category = { value: row.category, at: row.createdAt.toISOString() };
    }
    if (
      row.report &&
      (!m.report || row.createdAt.toISOString() > m.report.at)
    ) {
      m.report = { value: row.report, at: row.createdAt.toISOString() };
    }
  }
  const out = new Map<string, KnownMerchant>();
  for (const [key, m] of byMerchant) {
    out.set(key, {
      display: m.display,
      category: m.category?.value ?? "",
      report: m.report?.value ?? "",
    });
  }
  return out;
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

/** The base Expense fields shared by the full row mapping and the thin
 * duplicate-candidate mapping: the same null→"" defaults and the same
 * Decimal→2-dp conversion, so a change to one can't silently drift from
 * the other. "" is the domain's "no value" sentinel throughout. */
function expenseBase(row: {
  id: string;
  date: string | null;
  report: string | null;
  category: string | null;
  description: string | null;
  amount: Prisma.Decimal | null;
  reconciledAt: Date | null;
  createdAt: Date;
  updatedAt: Date | null;
}): {
  id: string;
  date: string;
  report: string;
  category: string;
  description: string;
  amount: string;
  reconciledAt: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    date: row.date ?? "",
    report: row.report ?? "",
    category: row.category ?? "",
    description: row.description ?? "",
    // Decimal → 2-dp string (the domain's "" means no amount). toFixed(2) is
    // a lossless pad: numeric(10,2) already stores exactly two digits.
    amount: row.amount?.toFixed(2) ?? "",
    reconciledAt: row.reconciledAt?.toISOString() ?? "",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? row.createdAt.toISOString(),
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
  reconciledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): Expense {
  const base = {
    ...expenseBase(row),
    type: row.type as Expense["type"],
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
    // Legacy rows predate the type column; they are business trips.
    mileageType: isMileageType(row.mileageType) ? row.mileageType : "business",
    locations: parseLocations(row.locations),
    distanceMiles: row.distanceMiles?.toFixed(2) ?? "",
    route: parseRoute(row.route),
  };
  return mileage;
}
