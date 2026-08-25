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

/** Add a named row (report/category) if it doesn't exist yet. */
export async function addNamedRow(
  model: NamedModel,
  noun: string,
  accountId: string,
  name: string,
): Promise<NamedResult> {
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Name can't be empty." };
  try {
    await model.create({ name: clean, accountId });
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
  model: NamedModel,
  noun: string,
  expenseField: "report" | "category",
  accountId: string,
  name: string,
  newName: string,
): Promise<NamedResult> {
  const clean = newName.trim();
  if (!clean) return { ok: false, error: "Name can't be empty." };
  if (clean === name) return { ok: false, error: "That's already the name." };
  const dup = await model.first({ accountId, name: clean });
  if (dup) {
    return { ok: false, error: `A ${noun} named "${clean}" already exists.` };
  }
  let renamed = 0;
  await db.transaction(async (tx) => {
    const isReport = expenseField === "report";
    await tx.orm.public.Expense.where((e) =>
      and(
        e.accountId.eq(accountId),
        isReport ? e.report.eq(name) : e.category.eq(name),
      ),
    ).updateAll({ [expenseField]: clean } as Record<string, string>);
    const rows = await model
      .where({ accountId, name })
      .updateAll({ name: clean });
    renamed = rows.length;
  });
  if (renamed === 0) {
    return { ok: false, error: `That ${noun} no longer exists.` };
  }
  return { ok: true };
}
