import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { isUniqueViolation } from "~/lib/db/pg-errors";

/**
 * Add/rename helpers shared by reports and categories; both are "named
 * rows" that expenses reference by name, so add and rename behave
 * identically (create-if-absent, rename the row plus every expense that
 * references the old name).
 */

/** A named-row collection: the subset of the Prisma 8 collection surface
 * the add/rename helpers use (the Report and Category models satisfy it). */
export interface NamedModel {
  create(data: { name: string; accountId: string }): Promise<unknown>;
  first(filter?: {
    accountId: string;
    name: string;
  }): PromiseLike<{ name: string } | null>;
  where(filter: { accountId: string; name: string }): {
    updateAll(data: { name: string }): PromiseLike<{ name: string }[]>;
  };
}

export type NamedResult = { ok: true } | { ok: false; error: string };

/** The transaction handle `db.transaction` hands its callback. */
type NamedTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A named-row collection bound to either the global client (the pre-check)
 * or the rename's transaction: every write inside the transaction must run
 * on the transaction's own connection, or it takes a second one from the
 * pool (max 2) and survives a rolled-back commit. */
export type NamedModelSource = (client: typeof db | NamedTx) => NamedModel;

/** Add a named row (report/category) if it doesn't exist yet. */
export async function addNamedRow(
  model: NamedModel,
  noun: string,
  accountId: string,
  name: string,
  /** Extra columns for the create (e.g. the reports table's
   * `createdAt`); categories pass nothing. */
  extra: Record<string, unknown> = {},
): Promise<NamedResult> {
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Name can't be empty." };
  try {
    await model.create({ name: clean, accountId, ...extra });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: `A ${noun} named "${clean}" already exists.` };
    }
    throw err;
  }
  return { ok: true };
}

/**
 * Rename a named row (report/category) and every expense that references it
 * by name. `expenseField` selects the expense column to rewrite
 * ("report" or "category").
 */
export async function renameNamedRow(
  model: NamedModelSource,
  noun: string,
  expenseField: "report" | "category",
  accountId: string,
  name: string,
  newName: string,
): Promise<NamedResult> {
  const clean = newName.trim();
  if (!clean) return { ok: false, error: "Name can't be empty." };
  if (clean === name) return { ok: false, error: "That's already the name." };
  const dup = await model(db).first({ accountId, name: clean });
  if (dup) {
    return { ok: false, error: `A ${noun} named "${clean}" already exists.` };
  }
  let renamed = 0;
  try {
    await db.transaction(async (tx) => {
      // The row goes first: when it is gone (a concurrent delete, or a
      // rename that already landed), nothing has been rewritten and the
      // caller's "no longer exists" is the whole truth. Rewriting expenses
      // first would leave them pointing at a name no row owns.
      const rows = await model(tx)
        .where({ accountId, name })
        .updateAll({ name: clean });
      renamed = rows.length;
      if (renamed === 0) return;
      const isReport = expenseField === "report";
      await tx.orm.public.Expense.where((e) =>
        and(
          e.accountId.eq(accountId),
          isReport ? e.report.eq(name) : e.category.eq(name),
        ),
      ).updateAll({ [expenseField]: clean } as Record<string, string>);
    });
  } catch (err) {
    // The pre-check above raced another rename to the same name: report the
    // same message instead of leaking the unique violation.
    if (isUniqueViolation(err)) {
      return { ok: false, error: `A ${noun} named "${clean}" already exists.` };
    }
    throw err;
  }
  if (renamed === 0) {
    return { ok: false, error: `That ${noun} no longer exists.` };
  }
  return { ok: true };
}
