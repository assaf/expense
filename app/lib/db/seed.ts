import { ulid } from "ulid";
import { MILEAGE_RATES } from "~/data/mileage-rates";
import { GENERAL_EMAIL_RULES } from "~/data/email-rules";
import { DEFAULT_CATEGORIES } from "~/lib/default-categories.server";
import { APP_EMAIL, APP_PASSWORD } from "~/lib/env";
import { generateInviteCode, hashPassword } from "~/lib/passwords";
import { all } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { asNumericOf, fromIso, toIso, toIsoOrNull } from "~/lib/db/wire";
import { isEmail } from "~/lib/validation";
import { isTest } from "~/lib/db/shared";
import type { MileageRateEntry } from "~/lib/mileage-rates";
import type { MileageType, User } from "~/lib/types";

/**
 * One-time (per-process) data seeding: bootstrap the first account/user from
 * APP_EMAIL/APP_PASSWORD, backfill the bootstrap user's email from APP_EMAIL
 * (legacy pre-email accounts logged in with a plain username), adopt
 * single-user era rows (accountId "") into that account, move legacy
 * duplicate-pair dismissals out of the settings blob, and sync the global
 * IRS mileage-rate master table from app/data/mileage-rates.ts.
 *
 * There is no runtime DDL: schema changes go through the migration flow
 * (docs/operations.md); this only seeds data.
 */

/** The query surface shared by db and an open db.transaction callback. */
type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

let ready: Promise<void> | undefined;

/** One-time (per process) data seeding: bootstrap user + adopt legacy rows
 * + sync the global IRS mileage-rate master table. */
export async function initStore(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const bootstrap = await ensureBootstrapUser();
      // Adopt single-user era rows (accountId "") into the bootstrap account.
      await db.transaction(async (tx) => {
        await tx.orm.public.Expense.where((m) => m.accountId.eq("")).updateAll({
          accountId: bootstrap.accountId,
        });
        await tx.orm.public.Report.where((m) => m.accountId.eq("")).updateAll({
          accountId: bootstrap.accountId,
        });
        await tx.orm.public.Category.where((m) => m.accountId.eq("")).updateAll(
          { accountId: bootstrap.accountId },
        );
        await tx.orm.public.Settings.where((m) => m.accountId.eq("")).updateAll(
          { accountId: bootstrap.accountId },
        );
      });
      await syncMileageRates();
      await syncGeneralEmailRules();
    })().catch((error) => {
      // Allow a retry on the next call if seeding failed partway.
      ready = undefined;
      throw error;
    });
  }
  await ready;
}

/**
 * The IRS mileage-rate master table (global, the same rates for every
 * account), synced from app/data/mileage-rates.ts whenever the seed
 * differs. Update the seed file to change rates; the next process start
 * applies it. Diff-based, so an unchanged seed is a no-op on every boot.
 */
async function syncMileageRates(): Promise<void> {
  const have = (await db.orm.public.MileageRate.all()).map(rateRowToEntry);
  const want = MILEAGE_RATES.map((r) => ({ ...r })).sort(byTypeThenStart);
  const same =
    have.length === want.length &&
    have.every((h, i) => rateEntryEquals(h, want[i]!));
  if (same) return;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.orm.public.MileageRate.where(() => all()).deleteAll();
    await tx.orm.public.MileageRate.createAll(
      want.map((r) => ({
        _type: r.type,
        startDate: r.startDate,
        endDate: r.endDate,
        rate: asNumericOf<5, 3>(r.rate),
        createdAt: fromIso(now),
      })),
    );
  });
  console.warn(
    "[initStore] Synced IRS mileage rates: %d rows (was %d)",
    want.length,
    have.length,
  );
}

/**
 * The GENERAL email rules (accountId = ""), synced from the seed file
 * (app/data/email-rules.ts), the same diff-based pattern as the mileage rates:
 * an unchanged seed is a no-op on every boot. User rules (scoped rows) and
 * removals made here (a general rule deleted from the seed) are never
 * touched: the sync only adds/updates rows whose sender is in the seed.
 */
async function syncGeneralEmailRules(): Promise<void> {
  const general = await db.orm.public.EmailRule.where((r) =>
    r.accountId.eq(""),
  ).all();
  const known = new Set(general.map((r) => r.sender));
  const missing = GENERAL_EMAIL_RULES.filter((r) => !known.has(r.sender));
  if (missing.length === 0) return;
  const now = new Date().toISOString();
  await db.orm.public.EmailRule.createAll(
    missing.map((r) => ({
      id: ulid(),
      accountId: "",
      sender: r.sender,
      source: "seed",
      createdAt: fromIso(now),
    })),
  );
  console.warn(
    "[initStore] Synced general email rules: +%d (was %d)",
    missing.length,
    general.length,
  );
}

function rateRowToEntry(row: {
  _type: string;
  startDate: string;
  endDate: string;
  rate: string;
}): MileageRateEntry {
  return {
    type: row._type as MileageType,
    startDate: row.startDate,
    endDate: row.endDate,
    // numeric(5,3) wire text keeps trailing zeros ("0.140"); the domain
    // value is the plain number string ("0.14"), matching the old
    // Prisma.Decimal.toString() behavior callers expect.
    rate: row.rate.replace(/0+$/, "").replace(/\.$/, ""),
  };
}

function byTypeThenStart(a: MileageRateEntry, b: MileageRateEntry): number {
  return a.type === b.type
    ? a.startDate.localeCompare(b.startDate)
    : a.type.localeCompare(b.type);
}

function rateEntryEquals(a: MileageRateEntry, b: MileageRateEntry): boolean {
  return (
    a.type === b.type &&
    a.startDate === b.startDate &&
    a.endDate === b.endDate &&
    a.rate === b.rate
  );
}

/** In-memory cache for the global IRS mileage rates table; it changes at
 * most once a year when new rates are published. 1-hour TTL is safe. */
let mileageRatesCache: {
  data: MileageRateEntry[];
  expiresAt: number;
} | null = null;
const MILEAGE_RATES_TTL_MS = 3_600_000;

/** All mileage rates in the global master table (newest period first). */
export async function readMileageRates(): Promise<MileageRateEntry[]> {
  if (
    !isTest &&
    mileageRatesCache &&
    mileageRatesCache.expiresAt > Date.now()
  ) {
    return mileageRatesCache.data;
  }
  await initStore();
  const rows = await db.orm.public.MileageRate.orderBy([
    (m) => m.startDate.desc(),
    (m) => m._type.asc(),
  ]).all();
  const data = rows.map(rateRowToEntry);
  mileageRatesCache = {
    data,
    expiresAt: Date.now() + MILEAGE_RATES_TTL_MS,
  };
  return data;
}

async function ensureBootstrapUser(): Promise<User> {
  const first = await db.orm.public.User.orderBy((u) =>
    u.createdAt.asc(),
  ).first();
  if (!first) return bootstrapUser();

  const email = APP_EMAIL.trim().toLowerCase();
  if (email && !isEmail(first.email)) {
    const taken = await db.orm.public.User.where((u) =>
      u.email.eq(email),
    ).first();
    if (!taken) {
      await db.orm.public.User.where({ id: first.id }).update({ email });
      console.warn(
        "[initStore] Backfilled bootstrap user email from APP_EMAIL: %s → %s",
        first.email,
        email,
      );
      return {
        id: first.id,
        accountId: first.accountId,
        email,
        emailVerifiedAt: toIsoOrNull(first.emailVerifiedAt),
        createdAt: toIso(first.createdAt),
      };
    }
  }
  return {
    id: first.id,
    accountId: first.accountId,
    email: first.email,
    emailVerifiedAt: toIsoOrNull(first.emailVerifiedAt),
    createdAt: toIso(first.createdAt),
  };
}

/** Create the very first account + user from APP_EMAIL/APP_PASSWORD. */
async function bootstrapUser(): Promise<User> {
  if (!APP_EMAIL || !APP_PASSWORD) {
    throw new Error(
      "No users exist and APP_EMAIL/APP_PASSWORD are not configured — " +
        "set them to create the first account and user.",
    );
  }

  const email = APP_EMAIL.trim().toLowerCase();
  if (!isEmail(email)) {
    throw new Error(
      "APP_EMAIL is not a valid email address — fix it in .env / the " +
        "deployment dashboard.",
    );
  }

  const now = new Date().toISOString();
  const accountId = ulid();
  const userId = ulid();
  await db.transaction(async (tx) => {
    await tx.orm.public.Account.create({
      id: accountId,
      name: email,
      inviteCode: generateInviteCode(),
      createdAt: fromIso(now),
    });
    await tx.orm.public.User.create({
      id: userId,
      accountId,
      email,
      passwordHash: await hashPassword(APP_PASSWORD),
      // The operator's bootstrap account needs no email verification
      // (it is created from APP_EMAIL/APP_PASSWORD, not a signup form).
      emailVerifiedAt: fromIso(now),
      createdAt: fromIso(now),
    });
    // The bootstrap email is also an allowed "receipts by email" sender.
    const existing = await tx.orm.public.InboundSender.where((s) =>
      s.accountId.eq(accountId),
    )
      .select("address")
      .all();
    if (!existing.some((s) => s.address === email)) {
      await tx.orm.public.InboundSender.create({
        accountId,
        address: email,
        createdAt: fromIso(now),
      });
    }
    await seedDefaultCategories(tx, accountId);
  });
  return { id: userId, accountId, email, emailVerifiedAt: now, createdAt: now };
}

/** Seed a new account with the IRS Schedule C default categories. */
export async function seedDefaultCategories(
  tx: Tx,
  accountId: string,
): Promise<void> {
  await tx.orm.public.Category.createAll(
    DEFAULT_CATEGORIES.map((name) => ({ name, accountId })),
  );
}
