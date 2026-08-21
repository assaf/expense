import { ulid } from "ulid";
import prisma from "~/lib/prisma.server";
import { duplicatePairKey } from "~/lib/duplicates";
import { createCache, isTest } from "~/lib/db/shared";
import { DEFAULT_SETTINGS, type Settings } from "~/lib/types";

/** Per-account cache for settings — 5-minute TTL. */
const settingsCache = createCache<Settings>(300_000);

export async function readSettings(accountId: string): Promise<Settings> {
  if (!isTest) {
    const cached = settingsCache.get(accountId);
    if (cached !== undefined) return cached;
  }
  const rows = await prisma.settings.findMany({ where: { accountId } });
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const kv: Record<string, string> = {};
  for (const row of rows) {
    if (row.key) kv[row.key] = row.value;
  }
  settings.homeAddress = kv["homeAddress"] ?? "";
  settings.homeLat = kv["homeLat"] ? Number(kv["homeLat"]) : null;
  settings.homeLng = kv["homeLng"] ? Number(kv["homeLng"]) : null;
  settings.welcomePending = kv["welcomePending"] === "1";
  settingsCache.set(accountId, settings);
  return settings;
}

export async function writeSettings(
  accountId: string,
  settings: Settings,
): Promise<void> {
  const rows = [
    { accountId, key: "homeAddress", value: settings.homeAddress },
    {
      accountId,
      key: "homeLat",
      value: settings.homeLat === null ? "" : String(settings.homeLat),
    },
    {
      accountId,
      key: "homeLng",
      value: settings.homeLng === null ? "" : String(settings.homeLng),
    },
    {
      accountId,
      key: "welcomePending",
      value: settings.welcomePending ? "1" : "",
    },
  ];
  await prisma.$transaction([
    prisma.settings.deleteMany({ where: { accountId } }),
    prisma.settings.createMany({ data: rows }),
  ]);
  settingsCache.delete(accountId);
}

/**
 * All expense pairs this account marked "not a duplicate", as the
 * order-independent pair keys duplicate matching filters on.
 */
export async function readDuplicateDismissals(
  accountId: string,
): Promise<Set<string>> {
  const rows = await prisma.duplicateDismissal.findMany({
    where: { accountId },
    select: { expenseAId: true, expenseBId: true },
  });
  return new Set(rows.map((r) => duplicatePairKey(r.expenseAId, r.expenseBId)));
}

/**
 * Mark an expense pair as "not a duplicate" so the warning never shows for
 * it again. Stored ordered (expenseAId < expenseBId) so dismissing works no
 * matter which side of the pair the user acted on; the unique constraint
 * makes it idempotent, and cascade deletes retire the row with either
 * expense. If one of the expenses is already gone there is nothing to
 * dismiss — the write is skipped.
 */
export async function dismissDuplicatePair(
  accountId: string,
  idA: string,
  idB: string,
): Promise<void> {
  const [expenseAId, expenseBId] = idA < idB ? [idA, idB] : [idB, idA];
  try {
    await prisma.duplicateDismissal.createMany({
      data: [{ id: ulid(), accountId, expenseAId, expenseBId }],
      skipDuplicates: true,
    });
  } catch (error) {
    if (isForeignKeyError(error)) return;
    throw error;
  }
}

/** Prisma error code for a foreign-key constraint violation (P2003). */
function isForeignKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2003"
  );
}
