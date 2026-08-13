import prisma from "~/lib/prisma.server";
import { createCache, isTest } from "~/lib/db/shared";
import { addNamedRow, renameNamedRow, type NamedResult } from "~/lib/db/names";
import type { Category } from "~/lib/types";

/** Per-account cache for categories — same 5-minute TTL as reports. */
const categoriesCache = createCache<Category[]>(300_000);

export async function readCategories(accountId: string): Promise<Category[]> {
  if (!isTest) {
    const cached = categoriesCache.get(accountId);
    if (cached !== undefined) return cached;
  }
  const rows = await prisma.category.findMany({
    where: { accountId, name: { not: "" } },
    select: { name: true },
  });
  const categories = rows
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((name) => ({ name }));
  categoriesCache.set(accountId, categories);
  return categories;
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
  return renameNamedRow(
    prisma.category,
    "category",
    "category",
    accountId,
    name,
    newName,
  ).then((r) => {
    categoriesCache.delete(accountId);
    return r;
  });
}

/**
 * Create a category if it doesn't exist yet. Returns an error message when
 * the name is empty or already taken.
 */
export function addCategory(
  accountId: string,
  name: string,
): Promise<NamedResult> {
  return addNamedRow(prisma.category, "category", accountId, name).then((r) => {
    categoriesCache.delete(accountId);
    return r;
  });
}

export async function removeCategory(
  accountId: string,
  name: string,
): Promise<void> {
  await prisma.category.deleteMany({ where: { accountId, name } });
  categoriesCache.delete(accountId);
}
