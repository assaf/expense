import prisma from "~/lib/prisma.server";
import type { Prisma } from "prisma/generated";

/**
 * Add/rename helpers shared by reports and categories — both are "named
 * rows" that expenses reference by name, so add and rename behave
 * identically (create-if-absent, rename the row plus every expense that
 * references the old name).
 */

/** The report/category model shape used by the add/rename helpers. */
interface NamedModel {
  createMany(args: {
    data: { name: string; accountId: string }[];
    skipDuplicates: boolean;
  }): Promise<{ count: number }>;
  findFirst(args: {
    where: { accountId: string; name: string };
  }): Promise<{ name: string } | null>;
  updateMany(args: {
    where: { accountId: string; name: string };
    data: { name: string };
  }): Prisma.PrismaPromise<Prisma.BatchPayload>;
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
  const result = await model.createMany({
    data: [{ name: clean, accountId }],
    skipDuplicates: true,
  });
  if (result.count === 0) {
    return { ok: false, error: `A ${noun} named "${clean}" already exists.` };
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
  const dup = await model.findFirst({ where: { accountId, name: clean } });
  if (dup) {
    return { ok: false, error: `A ${noun} named "${clean}" already exists.` };
  }
  const operations: Prisma.PrismaPromise<{ count: number }>[] = [
    prisma.expense.updateMany({
      where: { accountId, [expenseField]: name },
      data: { [expenseField]: clean },
    }),
    model.updateMany({ where: { accountId, name }, data: { name: clean } }),
  ];
  const results = await prisma.$transaction(operations);
  if (results[results.length - 1]!.count === 0) {
    return { ok: false, error: `That ${noun} no longer exists.` };
  }
  return { ok: true };
}
