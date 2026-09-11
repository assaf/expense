import { ulid } from "ulid";
import { db } from "~/lib/prisma.server";
import { isForeignKeyViolation, isUniqueViolation } from "~/lib/db/pg-errors";
import { duplicatePairKey } from "~/lib/duplicates";
import { bust, cachedRead, createCache } from "~/lib/db/shared";
import { DEFAULT_SETTINGS, type Settings } from "~/lib/types";

/** Per-account cache for settings (5-minute TTL). */
const settingsCache = createCache<Settings>(300_000);

export async function readSettings(accountId: string): Promise<Settings> {
  return cachedRead(settingsCache, accountId, async () => {
    const rows = await db.orm.public.Settings.where((s) =>
      s.accountId.eq(accountId),
    ).all();
    const settings: Settings = { ...DEFAULT_SETTINGS };
    const kv: Record<string, string> = {};
    for (const row of rows) {
      if (row.key) kv[row.key] = row.value;
    }
    settings.homeAddress = kv["homeAddress"] ?? "";
    settings.homeLat = kv["homeLat"] ? Number(kv["homeLat"]) : null;
    settings.homeLng = kv["homeLng"] ? Number(kv["homeLng"]) : null;
    settings.welcomePending = kv["welcomePending"] === "1";
    return settings;
  });
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
  await db.transaction(async (tx) => {
    await tx.orm.public.Settings.where((s) =>
      s.accountId.eq(accountId),
    ).deleteAll();
    await tx.orm.public.Settings.createAll(rows);
  });
  bust(settingsCache, accountId);
}

/**
 * All expense pairs this account marked "not a duplicate", as the
 * order-independent pair keys duplicate matching filters on.
 */
export async function readDuplicateDismissals(
  accountId: string,
): Promise<Set<string>> {
  const rows = await db.orm.public.DuplicateDismissal.where((d) =>
    d.accountId.eq(accountId),
  )
    .select("expenseAId", "expenseBId")
    .all();
  return new Set(rows.map((r) => duplicatePairKey(r.expenseAId, r.expenseBId)));
}

/**
 * Mark an expense pair as "not a duplicate" so the warning never shows for
 * it again. Stored ordered (expenseAId < expenseBId) so dismissing works no
 * matter which side of the pair the user acted on; the unique constraint
 * makes it idempotent, and cascade deletes retire the row with either
 * expense. If one of the expenses is already gone there is nothing to
 * dismiss, so the write is skipped.
 */
export async function dismissDuplicatePair(
  accountId: string,
  idA: string,
  idB: string,
): Promise<void> {
  const [expenseAId, expenseBId] = idA < idB ? [idA, idB] : [idB, idA];
  try {
    await db.orm.public.DuplicateDismissal.create({
      id: ulid(),
      accountId,
      expenseAId,
      expenseBId,
    });
  } catch (error) {
    // Unique constraint (already dismissed) or foreign key (an expense is
    // gone): both mean there is nothing left to do.
    if (isUniqueViolation(error) || isForeignKeyViolation(error)) return;
    throw error;
  }
}
