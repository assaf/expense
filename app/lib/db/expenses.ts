import { and, or } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { asJson, asNumeric, fromIso, toIso, toIsoOrNull } from "~/lib/db/wire";
import { normalizeMerchant } from "~/lib/duplicates";
import { deleteImage, mimeForFile } from "~/lib/images.server";
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

// --- Expenses --------------------------------------------------------------

export async function readExpenses(accountId: string): Promise<Expense[]> {
  const rows = await db.orm.public.Expense.where((e) =>
    e.accountId.eq(accountId),
  ).all();
  return rows.map(rowToExpense);
}

export async function readExpense(
  id: string,
  accountId: string,
): Promise<Expense | undefined> {
  const row = await db.orm.public.Expense.where((e) =>
    and(e.id.eq(id), e.accountId.eq(accountId)),
  ).first();
  return row ? rowToExpense(row) : undefined;
}

/** Expense row plus its image blob, for the image serving route: the home
 * list requests one image per receipt, and two sequential queries per tile
 * (expense, then blob) doubled the DB round trips. Prisma 8 has no raw-SQL
 * lane yet, so the old single LEFT JOIN became two queries (the blob key
 * comes from the expense row); the blob columns are null when the expense
 * has no image (or its blob row is missing); callers 404 on that, same as
 * a null blob read. */
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
  // Single query via SQL-builder outerLeftJoin (saves a second round trip
  // per image tile on the list page, which historically exhausted the
  // Supabase pooler).
  const plan = db.sql.public.expenses
    .outerLeftJoin(db.sql.public.image_blobs.as("ib"), (f, fns) =>
      fns.and(
        fns.eq(f.expenses.accountId, f.ib.accountId),
        fns.eq(f.expenses.imageFile, f.ib.key),
      ),
    )
    .select("id", "imageFile", "imageMime", "updatedAt")
    .select("_type", (f) => f.expenses.type)
    .select("blobMime", (f) => f.ib.mime)
    .select("blobData", (f) => f.ib.data)
    .select("thumbnail", (f) => f.ib.thumbnail)
    .where((f, fns) =>
      fns.and(
        fns.eq(f.expenses.id, id),
        fns.eq(f.expenses.accountId, accountId),
      ),
    )
    .limit(1)
    .build();

  const rows = await db.runtime().query(plan);
  const r = rows[0];
  if (!r) return undefined;

  const base: ExpenseImageRow = {
    type: r._type,
    imageFile: r.imageFile,
    imageMime: r.imageMime,
    updatedAt: toIso(r.updatedAt),
    blobMime: null,
    blobData: null,
    thumbnail: null,
  };
  if (!r.blobData) return base;
  return {
    ...base,
    blobMime: r.blobMime || mimeForFile(r.imageFile),
    blobData: r.blobData,
    thumbnail: r.thumbnail ?? null,
  };
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
    const prev = await db.orm.public.Expense.where((e) =>
      and(
        e.accountId.eq(accountId),
        e.date.gt(expense.date),
        e.id.neq(expense.id),
      ),
    )
      .orderBy((e) => e.date.asc())
      .select("id")
      .first();
    prevId = prev?.id ?? null;

    // Next: the expense with the closest *older* date (date < this one,
    // ordered descending).
    const next = await db.orm.public.Expense.where((e) =>
      and(
        e.accountId.eq(accountId),
        e.date.lt(expense.date),
        e.id.neq(expense.id),
      ),
    )
      .orderBy((e) => e.date.desc())
      .select("id")
      .first();
    if (next) {
      nextId = next.id;
    } else {
      // No older dated expense; fall back to the first undated row.
      const firstUndated = await db.orm.public.Expense.where((e) =>
        and(e.accountId.eq(accountId), e.date.eq(""), e.id.neq(expense.id)),
      )
        .orderBy((e) => e.createdAt.desc())
        .select("id")
        .first();
      nextId = firstUndated?.id ?? null;
    }
  } else {
    // Undated expense: prev is the closest newer undated, or the oldest
    // dated row when this is the first undated.
    const prevUndated = await db.orm.public.Expense.where((e) =>
      and(
        e.accountId.eq(accountId),
        e.date.eq(""),
        e.createdAt.gt(fromIso(expense.createdAt)),
        e.id.neq(expense.id),
      ),
    )
      .orderBy((e) => e.createdAt.asc())
      .select("id")
      .first();
    if (prevUndated) {
      prevId = prevUndated.id;
    } else {
      const oldestDated = await db.orm.public.Expense.where((e) =>
        and(e.accountId.eq(accountId), e.date.neq(""), e.id.neq(expense.id)),
      )
        .orderBy((e) => e.date.asc())
        .select("id")
        .first();
      prevId = oldestDated?.id ?? null;
    }

    // Next: closest older undated (createdAt < this one, ordered desc).
    const nextUndated = await db.orm.public.Expense.where((e) =>
      and(
        e.accountId.eq(accountId),
        e.date.eq(""),
        e.createdAt.lt(fromIso(expense.createdAt)),
        e.id.neq(expense.id),
      ),
    )
      .orderBy((e) => e.createdAt.desc())
      .select("id")
      .first();
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
  const rows = await db.orm.public.Expense.where((e) =>
    e.accountId.eq(accountId),
  )
    .select(
      "id",
      "_type",
      "date",
      "merchant",
      "amount",
      "distanceMiles",
      "locations",
      "report",
      "category",
      "description",
      "reconciledAt",
      "createdAt",
      "updatedAt",
    )
    .orderBy((e) => e.createdAt.asc())
    .all();
  return rows.map((r) => {
    const base = {
      ...expenseBase(r),
      type: r._type as Expense["type"],
    };
    if (r._type === "receipt") {
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
      distanceMiles: r.distanceMiles ?? "",
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
  const updated = await db.orm.public.Expense.where((e) =>
    and(e.id.eq(expense.id), e.accountId.eq(accountId)),
  ).updateAll(data);
  if (updated.length === 0) {
    await db.orm.public.Expense.create(data);
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
  const row = await db.orm.public.Expense.where((e) =>
    and(
      e.accountId.eq(accountId),
      e._type.eq("receipt"),
      e.id.neq(opts.excludeExpenseId),
      e.merchant.ilike(escapeLikePattern(opts.merchant)),
      e.amount.eq(asNumeric(opts.amount)),
      e.date.eq(opts.date),
      e.createdAt.gte(
        fromIso(new Date(Date.now() - RECENT_MATCH_WINDOW_MS).toISOString()),
      ),
      ...(opts.description ? [e.description.eq(opts.description)] : []),
    ),
  )
    .select("id", "createdAt")
    .first();
  return row ? { id: row.id, createdAt: toIso(row.createdAt) } : undefined;
}

/**
 * Imported receipts covering bank-notification charges: same amount on
 * the same date, any merchant (the merchant receipt names the store; the
 * notification names the bank, so merchant can't be part of the key).
 * ALL matches come back, not just the first: a day with several
 * same-amount charges has several notifications, and each receipt covers
 * exactly one charge, so inbox review pairs them one-to-one by count.
 * The caller excludes expenses that were created from notifications
 * themselves (they are a charge's record, not a cover). No match means
 * the notification is the only record and stays on the review list.
 * Exact date only: a near-midnight miss keeps the notification listed
 * (harmless) instead of risking a wrong supersede (data loss).
 */
export async function findChargeExpenses(
  accountId: string,
  amounts: string[],
  date: string,
): Promise<Array<{ id: string; createdAt: string }>> {
  if (amounts.length === 0) return [];
  const rows = await db.orm.public.Expense.where((e) =>
    and(
      e.accountId.eq(accountId),
      e._type.eq("receipt"),
      e.date.eq(date),
      or(...amounts.map((amount) => e.amount.eq(asNumeric(amount)))),
    ),
  )
    .select("id", "createdAt")
    .orderBy((e) => e.createdAt.asc())
    .all();
  return rows.map((r) => ({ id: r.id, createdAt: toIso(r.createdAt) }));
}

/** Escape LIKE/ILIKE wildcards so the pattern matches the literal text. */
function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function deleteExpense(
  id: string,
  accountId: string,
): Promise<void> {
  const target = await db.orm.public.Expense.where((e) =>
    and(e.id.eq(id), e.accountId.eq(accountId)),
  )
    .select("_type", "imageFile")
    .first();
  if (target) {
    await deleteReceiptImages(accountId, [
      { type: target._type, imageFile: target.imageFile },
    ]);
  }
  await db.orm.public.Expense.where((e) =>
    and(e.id.eq(id), e.accountId.eq(accountId)),
  ).deleteAll();
}

/** Distinct merchant names previously used, most-recent first. */
export async function readPriorMerchants(accountId: string): Promise<string[]> {
  const grouped = await db.orm.public.Expense.where((e) =>
    and(e.accountId.eq(accountId), e._type.eq("receipt"), e.merchant.neq("")),
  )
    .groupBy("merchant")
    .aggregate((a) => ({ last: a.max("createdAt") }));
  return grouped
    .sort((a, b) => (b.last ?? "").localeCompare(a.last ?? ""))
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
  const rows = await db.orm.public.Expense.where((e) =>
    and(
      e.accountId.eq(accountId),
      e._type.eq("receipt"),
      e.merchant.neq(""),
      e.createdAt.gte(fromIso(ninetyDaysAgo())),
    ),
  )
    .select("merchant", "category", "report", "createdAt")
    .all();
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
    const createdAt = toIso(row.createdAt);
    let m = byMerchant.get(key);
    if (!m) {
      m = {
        display: row.merchant.trim(),
        latestAt: createdAt,
        category: null,
        report: null,
      };
      byMerchant.set(key, m);
    }
    // Display name: the newest row's spelling wins.
    if (createdAt > m.latestAt) {
      m.latestAt = createdAt;
      m.display = row.merchant.trim();
    }
    // Per-field newest non-empty value wins: a field is inherited from
    // its own newest expense, even when the overall-newest row left it
    // empty.
    if (row.category && (!m.category || createdAt > m.category.at)) {
      m.category = { value: row.category, at: createdAt };
    }
    if (row.report && (!m.report || createdAt > m.report.at)) {
      m.report = { value: row.report, at: createdAt };
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

/** The typed create input for the Expense collection. */
export type ExpenseWrite = Parameters<
  (typeof db)["orm"]["public"]["Expense"]["create"]
>[0];

/** Expense fields for create/update, split by type. */
export function expenseData(e: Expense): ExpenseWrite {
  const common = {
    id: e.id,
    _type: e.type,
    date: e.date,
    report: e.report,
    category: e.category,
    description: e.description,
    // "" is the domain's "no amount" sentinel → NULL (nullable Decimal).
    amount: e.amount === "" ? null : asNumeric(e.amount),
    mileageType: e.type === "mileage" ? e.mileageType : "business",
    createdAt: fromIso(e.createdAt),
    updatedAt: fromIso(e.updatedAt),
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
      route: null,
    };
  }
  return {
    ...common,
    merchant: "",
    imageFile: "",
    imageMime: "",
    originalName: "",
    distanceMiles: e.distanceMiles === "" ? null : asNumeric(e.distanceMiles),
    locations: asJson(e.locations),
    route: e.route === null ? null : asJson(e.route),
  };
}

/** The base Expense fields shared by the full row mapping and the thin
 * duplicate-candidate mapping: the same null→"" defaults and the same
 * numeric-string handling, so a change to one can't silently drift from
 * the other. "" is the domain's "no value" sentinel throughout. */
function expenseBase(row: {
  id: string;
  date: string | null;
  report: string | null;
  category: string | null;
  description: string | null;
  amount: string | null;
  reconciledAt: string | null;
  createdAt: string;
  updatedAt: string | null;
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
    // numeric(10,2) wire text already carries exactly two decimals, so the
    // string is the 2-dp domain value as-is.
    amount: row.amount ?? "",
    reconciledAt: toIsoOrNull(row.reconciledAt) ?? "",
    createdAt: toIso(row.createdAt),
    updatedAt: toIsoOrNull(row.updatedAt) ?? toIso(row.createdAt),
  };
}

function rowToExpense(row: {
  id: string;
  _type: string;
  date: string;
  report: string;
  category: string;
  description: string;
  amount: string | null;
  merchant: string;
  imageFile: string;
  imageMime: string;
  originalName: string;
  distanceMiles: string | null;
  mileageType: string;
  locations: unknown;
  route: unknown;
  reconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
}): Expense {
  const base = {
    ...expenseBase(row),
    type: row._type as Expense["type"],
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
    distanceMiles: row.distanceMiles ?? "",
    route: parseRoute(row.route),
  };
  return mileage;
}
