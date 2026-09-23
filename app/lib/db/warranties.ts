import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { asJson, asNumeric, fromIso, toIso, toIsoOrNull } from "~/lib/db/wire";
import { deleteImages } from "~/lib/images.server";
import { parseWarrantyDocuments, type Warranty } from "~/lib/types";

// --- Warranties ------------------------------------------------------------

/** Every warranty in the account, newest purchase first. Grouping by expiry
 * is a view concern (see app/lib/warranty-expiry.ts): this is the plain read
 * the list page renders. */
export async function readWarranties(accountId: string): Promise<Warranty[]> {
  const rows = await db.orm.public.Warranty.where((w) =>
    w.accountId.eq(accountId),
  )
    .orderBy((w) => w.purchasedAt.desc())
    .all();
  return rows.map(rowToWarranty);
}

export async function readWarranty(
  id: string,
  accountId: string,
): Promise<Warranty | undefined> {
  const row = await db.orm.public.Warranty.where((w) =>
    and(w.id.eq(id), w.accountId.eq(accountId)),
  ).first();
  return row ? rowToWarranty(row) : undefined;
}

/** The warranties linked to one expense, for the receipt editor's card. */
export async function readWarrantiesForExpense(
  accountId: string,
  expenseId: string,
): Promise<Warranty[]> {
  if (!expenseId) return [];
  const rows = await db.orm.public.Warranty.where((w) =>
    and(w.accountId.eq(accountId), w.expenseId.eq(expenseId)),
  )
    .orderBy((w) => w.purchasedAt.desc())
    .all();
  return rows.map(rowToWarranty);
}

export async function upsertWarranty(
  warranty: Warranty,
  accountId: string,
): Promise<void> {
  // One UPDATE when the warranty exists, one INSERT when it doesn't. The id
  // is a client-generated ulid, so an account-scoped update that hits nothing
  // means "new warranty", never a takeover of another account's row.
  const data = { ...warrantyData(warranty), accountId };
  const updated = await db.orm.public.Warranty.where((w) =>
    and(w.id.eq(warranty.id), w.accountId.eq(accountId)),
  ).updateAll(data);
  if (updated.length === 0) {
    await db.orm.public.Warranty.create(data);
  }
}

/** Delete a warranty and its documents. The row goes first (a failed delete
 * leaves unreferenced blobs, which cost storage and nothing else) and the
 * blobs are dropped best-effort. */
export async function deleteWarranty(
  id: string,
  accountId: string,
): Promise<void> {
  const target = await db.orm.public.Warranty.where((w) =>
    and(w.id.eq(id), w.accountId.eq(accountId)),
  )
    .select("documents")
    .first();
  await db.orm.public.Warranty.where((w) =>
    and(w.id.eq(id), w.accountId.eq(accountId)),
  ).deleteAll();
  if (target) {
    await deleteImages(
      accountId,
      parseWarrantyDocuments(target.documents).map((d) => d.key),
    );
  }
}

/** The typed create input for the Warranty collection. */
type WarrantyWrite = Parameters<
  (typeof db)["orm"]["public"]["Warranty"]["create"]
>[0];

/** Warranty fields for create/update. "" is the domain's "no value"
 * sentinel: it becomes NULL on the nullable columns. */
function warrantyData(w: Warranty): WarrantyWrite {
  return {
    id: w.id,
    merchant: w.merchant,
    product: w.product,
    value: w.value === "" ? null : asNumeric(w.value),
    purchasedAt: w.purchasedAt,
    expiresAt: w.expiresAt,
    terms: w.terms,
    documents: asJson(w.documents),
    expenseId: w.expenseId || null,
    createdAt: fromIso(w.createdAt),
    updatedAt: fromIso(w.updatedAt),
  };
}

function rowToWarranty(row: {
  id: string;
  merchant: string;
  product: string;
  value: string | null;
  purchasedAt: string;
  expiresAt: string;
  terms: string;
  documents: unknown;
  expenseId: string | null;
  createdAt: string;
  updatedAt: string | null;
}): Warranty {
  return {
    id: row.id,
    merchant: row.merchant ?? "",
    product: row.product ?? "",
    // numeric(10,2) wire text already carries exactly two decimals, so the
    // string is the 2-dp domain value as-is.
    value: row.value ?? "",
    purchasedAt: row.purchasedAt ?? "",
    expiresAt: row.expiresAt ?? "",
    terms: row.terms ?? "",
    documents: parseWarrantyDocuments(row.documents),
    expenseId: row.expenseId ?? "",
    createdAt: toIso(row.createdAt),
    updatedAt: toIsoOrNull(row.updatedAt) ?? toIso(row.createdAt),
  };
}
