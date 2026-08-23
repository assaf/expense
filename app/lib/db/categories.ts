import prisma from "~/lib/prisma.server";
import { bust, cachedRead, createCache } from "~/lib/db/shared";
import { addNamedRow, renameNamedRow, type NamedResult } from "~/lib/db/names";
import type { Category } from "~/lib/types";

/** Per-account cache for categories — same 5-minute TTL as reports. */
const categoriesCache = createCache<Category[]>(300_000);

export async function readCategories(accountId: string): Promise<Category[]> {
  return cachedRead(categoriesCache, accountId, async () => {
    const rows = await prisma.category.findMany({
      where: { accountId, name: { not: "" } },
      select: { name: true },
    });
    return rows
      .map((c) => c.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .map((name) => ({ name }));
  });
}

/**
 * Rename a category and every expense that uses it. Returns an error
 * message when the rename can't happen (empty, unchanged, duplicate).
 */
export function renameCategory(
  accountId: string,
  name: string,
  newName: string,
): Promise<NamedResult> {
  return bust(
    categoriesCache,
    accountId,
    renameNamedRow(
      prisma.category,
      "category",
      "category",
      accountId,
      name,
      newName,
    ),
  );
}

/**
 * Create a category if it doesn't exist yet. Returns an error message when
 * the name is empty or already taken.
 */
export function addCategory(
  accountId: string,
  name: string,
): Promise<NamedResult> {
  return bust(
    categoriesCache,
    accountId,
    addNamedRow(prisma.category, "category", accountId, name),
  );
}

export async function removeCategory(
  accountId: string,
  name: string,
): Promise<void> {
  await prisma.category.deleteMany({ where: { accountId, name } });
  bust(categoriesCache, accountId);
}
