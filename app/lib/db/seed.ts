import { ulid } from "ulid";
import { MILEAGE_RATES } from "~/data/mileage-rates";
import { GENERAL_EMAIL_RULES } from "~/data/email-rules";
import { DEFAULT_CATEGORIES } from "~/lib/default-categories.server";
import { APP_EMAIL, APP_PASSWORD } from "~/lib/env";
import { generateInviteCode, hashPassword } from "~/lib/passwords";
import prisma from "~/lib/prisma.server";
import { isEmail } from "~/lib/validation";
import { isTest } from "~/lib/db/shared";
import type { Prisma } from "prisma/generated";
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
 * There is no runtime DDL — schema changes go through `prisma migrate` /
 * `pnpm db:push`; this only seeds data.
 */

/** The subset of Prisma delegates that carry legacy accountId "" rows. */
interface AccountAdopter {
  updateMany(args: {
    where: { accountId: string };
    data: { accountId: string };
  }): Promise<unknown>;
}

let ready: Promise<void> | undefined;

/** One-time (per process) data seeding: bootstrap user + adopt legacy rows
 * + sync the global IRS mileage-rate master table. */
export async function initStore(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const bootstrap = await ensureBootstrapUser();
      // Adopt single-user era rows (accountId "") into the bootstrap account.
      const adopters: AccountAdopter[] = [
        prisma.expense,
        prisma.report,
        prisma.category,
        prisma.settings,
      ];
      for (const model of adopters) {
        await model.updateMany({
          where: { accountId: "" },
          data: { accountId: bootstrap.accountId },
        });
      }
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
 * The IRS mileage-rate master table (global — the same rates for every
 * account), synced from app/data/mileage-rates.ts whenever the seed
 * differs. Update the seed file to change rates; the next process start
 * applies it. Diff-based, so an unchanged seed is a no-op on every boot.
 */
async function syncMileageRates(): Promise<void> {
  const have = (await prisma.mileageRate.findMany()).map(rateRowToEntry);
  const want = MILEAGE_RATES.map((r) => ({ ...r })).sort(byTypeThenStart);
  const same =
    have.length === want.length &&
    have.every((h, i) => rateEntryEquals(h, want[i]!));
  if (same) return;
  const now = new Date().toISOString();
  await prisma.$transaction([
    prisma.mileageRate.deleteMany({}),
    prisma.mileageRate.createMany({
      data: want.map((r) => ({ ...r, createdAt: now })),
    }),
  ]);
  console.warn(
    "[initStore] Synced IRS mileage rates: %d rows (was %d)",
    want.length,
    have.length,
  );
}

/**
 * The GENERAL email rules (accountId = ""), synced from the seed file
 * (app/data/email-rules.ts) — same diff-based pattern as the mileage rates:
 * an unchanged seed is a no-op on every boot. User rules (scoped rows) and
 * removals made here (a general rule deleted from the seed) are never
 * touched: the sync only adds/updates rows whose sender is in the seed.
 */
async function syncGeneralEmailRules(): Promise<void> {
  const general = await prisma.emailRule.findMany({ where: { accountId: "" } });
  const known = new Set(general.map((r) => r.sender));
  const missing = GENERAL_EMAIL_RULES.filter((r) => !known.has(r.sender));
  if (missing.length === 0) return;
  const now = new Date().toISOString();
  await prisma.emailRule.createMany({
    data: missing.map((r) => ({
      id: ulid(),
      accountId: "",
      sender: r.sender,
      source: "seed",
      createdAt: now,
    })),
    skipDuplicates: true,
  });
  console.warn(
    "[initStore] Synced general email rules: +%d (was %d)",
    missing.length,
    general.length,
  );
}

function rateRowToEntry(row: {
  type: string;
  startDate: string;
  endDate: string;
  rate: Prisma.Decimal;
}): MileageRateEntry {
  return {
    type: row.type as MileageType,
    startDate: row.startDate,
    endDate: row.endDate,
    rate: row.rate.toString(),
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

/** In-memory cache for the global IRS mileage rates table — it changes at
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
  const rows = await prisma.mileageRate.findMany({
    orderBy: [{ startDate: "desc" }, { type: "asc" }],
  });
  const data = rows.map(rateRowToEntry);
  mileageRatesCache = {
    data,
    expiresAt: Date.now() + MILEAGE_RATES_TTL_MS,
  };
  return data;
}

async function ensureBootstrapUser(): Promise<User> {
  const first = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!first) return bootstrapUser();

  const email = APP_EMAIL.trim().toLowerCase();
  if (email && !isEmail(first.email)) {
    const taken = await prisma.user.findUnique({ where: { email } });
    if (!taken) {
      await prisma.user.update({
        where: { id: first.id },
        data: { email },
      });
      console.warn(
        "[initStore] Backfilled bootstrap user email from APP_EMAIL: %s → %s",
        first.email,
        email,
      );
      return {
        ...first,
        email,
        emailVerifiedAt: first.emailVerifiedAt?.toISOString() ?? null,
        createdAt: first.createdAt.toISOString(),
      };
    }
  }
  return {
    ...first,
    emailVerifiedAt: first.emailVerifiedAt?.toISOString() ?? null,
    createdAt: first.createdAt.toISOString(),
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
  await prisma.$transaction([
    prisma.account.create({
      data: {
        id: accountId,
        name: email,
        inviteCode: generateInviteCode(),
        createdAt: now,
      },
    }),
    prisma.user.create({
      data: {
        id: userId,
        accountId,
        email,
        passwordHash: await hashPassword(APP_PASSWORD),
        // The operator's bootstrap account needs no email verification
        // (it is created from APP_EMAIL/APP_PASSWORD, not a signup form).
        emailVerifiedAt: now,
        createdAt: now,
      },
    }),
    // The bootstrap email is also an allowed "receipts by email" sender.
    prisma.inboundSender.createMany({
      data: [{ accountId, address: email, createdAt: now }],
      skipDuplicates: true,
    }),
    seedDefaultCategories(accountId),
  ]);
  return { id: userId, accountId, email, emailVerifiedAt: now, createdAt: now };
}

/** Seed a new account with the IRS Schedule C default categories. */
export function seedDefaultCategories(
  accountId: string,
): Prisma.PrismaPromise<{ count: number }> {
  return prisma.category.createMany({
    data: DEFAULT_CATEGORIES.map((name) => ({ name, accountId })),
    skipDuplicates: true,
  });
}
