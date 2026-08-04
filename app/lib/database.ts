import { createHash, randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { MILEAGE_RATES } from "~/data/mileage-rates";
import { duplicatePairKey, normalizeMerchant } from "~/lib/duplicates";
import { APP_EMAIL, APP_PASSWORD } from "~/lib/env";
import { summarizeByReport } from "~/lib/format";
import { deleteImage } from "~/lib/images.server";
import { isMileageType, type MileageRateEntry } from "~/lib/mileage-rates";
import { generateInviteCode, hashPassword } from "~/lib/passwords";
import prisma from "~/lib/prisma.server";
import type { Prisma } from "prisma/generated";
import { DEFAULT_CATEGORIES } from "~/lib/default-categories.server";
import { DEFAULT_SETTINGS, parseLocations, parseRoute } from "~/lib/types";
import { isEmail } from "~/lib/validation";
import type {
  Account,
  Category,
  Expense,
  InboundEmailRecord,
  InboundSenderRecord,
  MileageExpense,
  MileageType,
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthTokenRecord,
  ReceiptExpense,
  Report,
  Settings,
  User,
} from "~/lib/types";

/**
 * Postgres-backed store via Prisma (see prisma/schema.prisma — the single
 * schema source of truth). All accounts/users/expenses/reports/categories/
 * settings/mileage/image-blob reads and writes go through here.
 *
 * Every domain row belongs to an account (`accountId`); all reads and writes
 * are scoped to the caller's account so users only ever see their own
 * account's data. Multiple users may belong to one account and share its
 * expenses, reports, categories, and settings.
 *
 * There is no runtime DDL: schema changes go through `prisma migrate` /
 * `pnpm db:push`. `initStore` only performs one-time data seeding: it
 * bootstraps the first account/user from APP_EMAIL/APP_PASSWORD, backfills
 * the bootstrap user's email from APP_EMAIL (legacy pre-email accounts
 * logged in with a plain username), and adopts single-user era rows
 * (accountId '') into that account.
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
        prisma.mileage,
        prisma.settings,
      ];
      for (const model of adopters) {
        await model.updateMany({
          where: { accountId: "" },
          data: { accountId: bootstrap.accountId },
        });
      }
      await migrateImageBlobKeys(bootstrap.accountId);
      await syncMileageRates();
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

/** All mileage rates in the global master table (newest period first). */
export async function readMileageRates(): Promise<MileageRateEntry[]> {
  await initStore();
  const rows = await prisma.mileageRate.findMany({
    orderBy: [{ startDate: "desc" }, { type: "asc" }],
  });
  return rows.map(rateRowToEntry);
}

/**
 * One-time (idempotent) fix-up for the pre-account era image keys: blobs were
 * global (`images/{name}`); they are now namespaced per account
 * (`images/{accountId}/{name}`). Backfills the account from the owning
 * expense, adopts orphans into the bootstrap account, and rewrites the keys
 * on image_blobs + expenses.imageFile. No-op once every key is namespaced.
 */
async function migrateImageBlobKeys(bootstrapAccountId: string): Promise<void> {
  // Backfill accountId from the expense that references each blob.
  await prisma.$executeRaw`
    UPDATE "image_blobs" SET "accountId" = e."accountId"
    FROM (SELECT DISTINCT "imageFile", "accountId" FROM "expenses" WHERE "imageFile" <> '') e
    WHERE "image_blobs"."key" = e."imageFile" AND "image_blobs"."accountId" = ''
  `;
  // Orphans (no expense references them) go to the bootstrap account.
  await prisma.$executeRaw`
    UPDATE "image_blobs" SET "accountId" = ${bootstrapAccountId} WHERE "accountId" = ''
  `;
  // Namespace legacy keys: images/X → images/{accountId}/X, and bare names
  // (CSV-era expenses stored filenames without the prefix) get the full path.
  await prisma.$executeRaw`
    UPDATE "image_blobs"
    SET "key" = CASE
      WHEN "key" LIKE 'images/%' THEN 'images/' || "accountId" || '/' || substr("key", 8)
      ELSE 'images/' || "accountId" || '/' || "key"
    END
    WHERE "key" <> '' AND "key" NOT LIKE 'images/%/%'
  `;
  // Mirror the same rewrite into expenses.imageFile.
  await prisma.$executeRaw`
    UPDATE "expenses"
    SET "imageFile" = CASE
      WHEN "imageFile" LIKE 'images/%' THEN 'images/' || "accountId" || '/' || substr("imageFile", 8)
      ELSE 'images/' || "accountId" || '/' || "imageFile"
    END
    WHERE "imageFile" <> '' AND "imageFile" NOT LIKE 'images/%/%'
  `;
}

/**
 * Guarantee at least one user exists. On an empty database, creates the
 * bootstrap account + user from APP_EMAIL/APP_PASSWORD (fail-closed if
 * missing). Otherwise returns the oldest existing user — used as the target
 * account for adopting legacy (pre-account) rows.
 *
 * One-time legacy fix-up: accounts created before emails were login names
 * stored a plain username (e.g. "assaf") in the email column. When
 * APP_EMAIL is configured, the bootstrap user (the oldest user — the same
 * one the bootstrap flow would have created) gets that address, so the
 * configured credentials keep working after the username→email switch.
 */
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
      return { ...first, email };
    }
  }
  return first;
}

/** Create the very first account + user from APP_EMAIL/APP_PASSWORD. */ async function bootstrapUser(): Promise<User> {
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
  return { id: userId, accountId, email, createdAt: now };
}

// --- Accounts & Users ------------------------------------------------------

/** Seed a new account with the IRS Schedule C default categories. */
function seedDefaultCategories(
  accountId: string,
): Prisma.PrismaPromise<{ count: number }> {
  return prisma.category.createMany({
    data: DEFAULT_CATEGORIES.map((name) => ({ name, accountId })),
    skipDuplicates: true,
  });
}

export async function readAccount(id: string): Promise<Account | undefined> {
  const row = await prisma.account.findUnique({ where: { id } });
  return row ?? undefined;
}

/**
 * The bootstrap user (oldest user) — the MCP smoke check issues an OAuth
 * token for them directly. Undefined only when the database has no users.
 */
export async function readBootstrapUser(): Promise<User | undefined> {
  await initStore();
  const first = await prisma.user.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, accountId: true, email: true, createdAt: true },
  });
  return first ?? undefined;
}

/** Create a new account. Throws if the name is already taken. */
export async function createAccount(name: string): Promise<Account> {
  const clean = name.trim();
  if (!clean) throw new Error("Account name is required");
  await initStore();
  const clash = await prisma.account.findUnique({ where: { name: clean } });
  if (clash) throw new Error("An account with that name already exists");
  const account: Account = {
    id: ulid(),
    name: clean,
    inviteCode: generateInviteCode(),
    createdAt: new Date().toISOString(),
  };
  // The account is created with the IRS Schedule C default categories so
  // receipts can be categorized immediately.
  await prisma.$transaction([
    prisma.account.create({ data: account }),
    seedDefaultCategories(account.id),
  ]);
  return account;
}

export async function findAccountByInviteCode(
  inviteCode: string,
): Promise<Account | undefined> {
  const row = await prisma.account.findUnique({ where: { inviteCode } });
  return row ?? undefined;
}

/** Replace an account's invite code with a fresh one; returns the new code. */
export async function regenerateInviteCode(accountId: string): Promise<string> {
  const code = generateInviteCode();
  await prisma.account.update({
    where: { id: accountId },
    data: { inviteCode: code },
  });
  return code;
}

/** Create a user in an account. Throws if the email is already taken. */
export async function createUser(input: {
  accountId: string;
  email: string;
  passwordHash: string;
}): Promise<User> {
  await initStore();
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("Email is required");
  const clash = await prisma.user.findUnique({ where: { email } });
  if (clash) throw new Error("That email is already in use");
  const user: User = {
    id: ulid(),
    accountId: input.accountId,
    email,
    createdAt: new Date().toISOString(),
  };
  // The registering email becomes an allowed "receipts by email" sender by
  // default — the account can remove it or add more addresses in Settings.
  await prisma.$transaction([
    prisma.user.create({
      data: { ...user, passwordHash: input.passwordHash },
    }),
    prisma.inboundSender.createMany({
      data: [
        {
          accountId: input.accountId,
          address: email,
          createdAt: user.createdAt,
        },
      ],
      skipDuplicates: true,
    }),
  ]);
  return user;
}

export async function findUserByEmail(
  email: string,
): Promise<User | undefined> {
  const row = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  return row ?? undefined;
}

/** Short-lived in-process cache for findUserById — every request re-resolves
 * the session's user (requireUser), and image-heavy pages fire dozens of
 * those per render; caching the lookup for a few seconds cuts the connection
 * churn that exhausts the Supabase session pooler under load. Only successful
 * lookups are cached; a deleted user is re-checked after the TTL (and a stale
 * hit merely means the next request redirects to login). */
const userCache = new Map<string, { user: User; expiresAt: number }>();
const USER_CACHE_TTL_MS = 30_000;

export async function findUserById(id: string): Promise<User | undefined> {
  const cached = userCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  const row = await prisma.user.findUnique({ where: { id } });
  const user = row
    ? {
        id: row.id,
        accountId: row.accountId,
        email: row.email,
        createdAt: row.createdAt,
      }
    : undefined;
  if (user)
    userCache.set(id, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  return user;
}

/** The stored password hash for a user (never exposed on the User type). */
export async function getPasswordHash(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  return row?.passwordHash ?? "";
}

// --- Expenses --------------------------------------------------------------

export async function readExpenses(accountId: string): Promise<Expense[]> {
  const rows = await prisma.expense.findMany({ where: { accountId } });
  return rows.map(rowToExpense);
}

export async function readExpense(
  id: string,
  accountId: string,
): Promise<Expense | undefined> {
  const row = await prisma.expense.findFirst({
    where: { id, accountId },
  });
  return row ? rowToExpense(row) : undefined;
}

async function writeExpenses(
  accountId: string,
  expenses: Expense[],
): Promise<void> {
  await prisma.$transaction([
    prisma.expense.deleteMany({ where: { accountId } }),
    prisma.expense.createMany({
      data: expenses.map((e) => ({ ...expenseData(e), accountId })),
    }),
    prisma.mileage.deleteMany({ where: { accountId } }),
    prisma.mileage.createMany({
      data: expenses
        .filter((e): e is MileageExpense => e.type === "mileage")
        .map((e) => ({
          date: e.date,
          report: e.report,
          locations: e.locations
            .map((l) => l.address)
            .filter(Boolean)
            .join(" → "),
          distanceMiles: e.distanceMiles === "" ? null : e.distanceMiles,
          accountId,
        })),
    }),
  ]);
}

export async function upsertExpense(
  expense: Expense,
  accountId: string,
): Promise<void> {
  const all = await readExpenses(accountId);
  const i = all.findIndex((e) => e.id === expense.id);
  if (i >= 0) all[i] = expense;
  else all.push(expense);
  await writeExpenses(accountId, all);
}

export async function deleteExpense(
  id: string,
  accountId: string,
): Promise<void> {
  const all = await readExpenses(accountId);
  const target = all.find((e) => e.id === id);
  if (target) await deleteReceiptImages(accountId, [target]);
  await writeExpenses(
    accountId,
    all.filter((e) => e.id !== id),
  );
}

/** Distinct merchant names previously used, most-recent first. */
export async function readPriorMerchants(accountId: string): Promise<string[]> {
  const grouped = await prisma.expense.groupBy({
    by: ["merchant"],
    where: { accountId, type: "receipt", merchant: { not: "" } },
    _max: { createdAt: true },
  });
  return grouped
    .sort((a, b) =>
      (b._max.createdAt ?? "").localeCompare(a._max.createdAt ?? ""),
    )
    .map((g) => g.merchant);
}

/**
 * The most recent category each merchant was filed under, keyed by the
 * normalized merchant name (same normalization as duplicate detection, so
 * "Blue Bottle" and "blue  bottle" are the same merchant). Only merchants
 * with at least one categorized expense appear; when a merchant has
 * categorized expenses from different times, the newest wins. Used when a
 * new receipt's merchant matches a previous one — the category is reused
 * instead of guessed.
 */
export async function readMerchantCategories(
  accountId: string,
): Promise<Map<string, string>> {
  const rows = await prisma.expense.findMany({
    where: {
      accountId,
      type: "receipt",
      merchant: { not: "" },
      category: { not: "" },
    },
    select: { merchant: true, category: true, createdAt: true },
  });
  const latest = new Map<string, { category: string; createdAt: string }>();
  for (const row of rows) {
    const key = normalizeMerchant(row.merchant);
    if (!key) continue;
    const prev = latest.get(key);
    if (!prev || row.createdAt > prev.createdAt) {
      latest.set(key, { category: row.category, createdAt: row.createdAt });
    }
  }
  const byMerchant = new Map<string, string>();
  for (const [key, value] of latest) byMerchant.set(key, value.category);
  return byMerchant;
}

/**
 * Category names + prior merchant categories — the extraction context shared
 * by the draft-image and inbound-email pipelines. Loading both up front is
 * one round-trip; the merchant's previous category (normalized name match)
 * is reused instead of re-guessed.
 */
export async function readExtractionContext(
  accountId: string,
): Promise<{ categories: string[]; merchantCategories: Map<string, string> }> {
  const [categories, merchantCategories] = await Promise.all([
    readCategories(accountId).then((cs) => cs.map((c) => c.name)),
    readMerchantCategories(accountId),
  ]);
  return { categories, merchantCategories };
}

// --- Reports & Categories --------------------------------------------------

// Reports come back in creation order: auto-increment ids are strictly
// increasing, so `id asc` is chronological — oldest first, newest last.
export async function readReports(accountId: string): Promise<Report[]> {
  const rows = await prisma.report.findMany({
    where: { accountId, name: { not: "" } },
    orderBy: { id: "asc" },
    select: { name: true, closed: true },
  });
  return rows.map((r) => ({ name: r.name, closed: r.closed }));
}

/**
 * Number of expenses in each report (reports are referenced by name — no
 * foreign key). Only reports that actually have expenses appear in the map.
 */
export async function readReportCounts(
  accountId: string,
): Promise<Map<string, number>> {
  const groups = await prisma.expense.groupBy({
    by: ["report"],
    where: { accountId, report: { not: "" } },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.report, g._count._all]));
}

/**
 * Expenses per category that belong to reports that are NOT closed (an
 * expense with no report counts — it isn't in any closed report). Categories
 * are referenced by name; only categories with live expenses appear.
 */
export async function readCategoryCounts(
  accountId: string,
): Promise<Map<string, number>> {
  const [groups, reports] = await Promise.all([
    prisma.expense.groupBy({
      by: ["category", "report"],
      where: { accountId, category: { not: "" } },
      _count: { _all: true },
    }),
    prisma.report.findMany({
      where: { accountId },
      select: { name: true, closed: true },
    }),
  ]);
  const closed = new Set(reports.filter((r) => r.closed).map((r) => r.name));
  const counts = new Map<string, number>();
  for (const g of groups) {
    if (closed.has(g.report)) continue;
    counts.set(g.category, (counts.get(g.category) ?? 0) + g._count._all);
  }
  return counts;
}

/** True when a report with this name exists (open or closed). Used by the
 * MCP export_report tool — the report must exist, but closed reports are
 * still exportable. */
export async function reportExists(
  accountId: string,
  name: string,
): Promise<boolean> {
  return (await readReports(accountId)).some((r) => r.name === name);
}

/**
 * Find a report that can accept expenses: exists and is not closed. Returns
 * the report, or an error message when it doesn't exist or is closed. Every
 * "report must exist and be open" check — the web expense save path and the
 * MCP capture_receipt / log_mileage / add_to_report tools — goes through
 * this one helper, so the validation and its error text live in one place.
 */
export async function findOpenReport(
  accountId: string,
  name: string,
): Promise<{ report: Report; error: null } | { report: null; error: string }> {
  const report = (await readReports(accountId)).find((r) => r.name === name);
  if (!report) {
    return {
      report: null,
      error: `Report "${name}" doesn't exist — create it first with create_report.`,
    };
  }
  if (report.closed) {
    return { report: null, error: `Report "${name}" is closed.` };
  }
  return { report, error: null };
}

/** One report's expense count and exact total (2-dp string). */
export interface ReportSummary {
  name: string;
  closed: boolean;
  count: number;
  total: string;
}

/**
 * All reports with their expense counts and exact totals — the shape shared
 * by the export page and the MCP list_reports tool. Counts and totals come
 * from the same summarizeByReport pass, so they always agree.
 */
export async function readReportSummaries(
  accountId: string,
): Promise<ReportSummary[]> {
  const [reports, expenses] = await Promise.all([
    readReports(accountId),
    readExpenses(accountId),
  ]);
  const byReport = summarizeByReport(expenses);
  return reports.map((r) => ({
    name: r.name,
    closed: r.closed,
    count: byReport.get(r.name)?.count ?? 0,
    total: byReport.get(r.name)?.total.toFixed(2) ?? "0.00",
  }));
}

// --- Add/rename helpers shared by reports and categories -------------------

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

type NamedResult = { ok: true } | { ok: false; error: string };

/** Add a named row (report/category) if it doesn't exist yet. */
async function addNamedRow(
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
 * ("report" or "category"); reports also rename their derived mileage rows.
 */
async function renameNamedRow(
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
  ];
  if (expenseField === "report") {
    operations.push(
      prisma.mileage.updateMany({
        where: { accountId, report: name },
        data: { report: clean },
      }),
    );
  }
  operations.push(
    model.updateMany({ where: { accountId, name }, data: { name: clean } }),
  );
  const results = await prisma.$transaction(operations);
  if (results[results.length - 1]!.count === 0) {
    return { ok: false, error: `That ${noun} no longer exists.` };
  }
  return { ok: true };
}

/**
 * Create a report if it doesn't exist yet. Returns an error message when
 * the name is empty or already taken.
 */
export function addReport(
  accountId: string,
  name: string,
): Promise<NamedResult> {
  return addNamedRow(prisma.report, "report", accountId, name);
}

/**
 * Delete a report together with every expense in it — including their
 * receipt images and the derived mileage rows. Expenses reference reports
 * by name, so the cascade is a same-account name match, executed in one
 * transaction. An empty name is a no-op: it must never touch the
 * "unassigned" expenses (report: "").
 */
export async function removeReport(
  accountId: string,
  name: string,
): Promise<void> {
  if (!name.trim()) return;
  const removed = await prisma.expense.findMany({
    where: { accountId, report: name },
    select: { type: true, imageFile: true },
  });
  await deleteReceiptImages(accountId, removed);
  await prisma.$transaction([
    prisma.expense.deleteMany({ where: { accountId, report: name } }),
    prisma.mileage.deleteMany({ where: { accountId, report: name } }),
    prisma.report.deleteMany({ where: { accountId, name } }),
  ]);
}

/**
 * Rename a report and every reference to it: the report row, its expenses,
 * and the derived mileage rows. Receipt image keys keep their old
 * convention name — re-saving a receipt rewrites them. Returns an error
 * message when the rename can't happen (empty, unchanged, duplicate).
 */
export function renameReport(
  accountId: string,
  name: string,
  newName: string,
): Promise<NamedResult> {
  return renameNamedRow(
    prisma.report,
    "report",
    "report",
    accountId,
    name,
    newName,
  );
}

/** Mark a report closed (or reopen it). Closed reports delete with confirmation. */
export async function setReportClosed(
  accountId: string,
  name: string,
  closed: boolean,
): Promise<void> {
  await prisma.report.updateMany({
    where: { accountId, name },
    data: { closed },
  });
}

export async function readCategories(accountId: string): Promise<Category[]> {
  const rows = await prisma.category.findMany({
    where: { accountId, name: { not: "" } },
    select: { name: true },
  });
  // Alphabetical (case-insensitive) so the settings list and the pickers in
  // the editor are easy to scan, whatever order the rows were created in.
  return rows
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((name) => ({ name }));
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
  return addNamedRow(prisma.category, "category", accountId, name);
}

export async function removeCategory(
  accountId: string,
  name: string,
): Promise<void> {
  await prisma.category.deleteMany({ where: { accountId, name } });
}

// --- Settings --------------------------------------------------------------

export async function readSettings(accountId: string): Promise<Settings> {
  const rows = await prisma.settings.findMany({ where: { accountId } });
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const kv: Record<string, string> = {};
  for (const row of rows) {
    if (row.key) kv[row.key] = row.value;
  }
  settings.homeAddress = kv["homeAddress"] ?? "";
  settings.homeLat = kv["homeLat"] ? Number(kv["homeLat"]) : null;
  settings.homeLng = kv["homeLng"] ? Number(kv["homeLng"]) : null;
  settings.duplicateDismissals = parseDuplicateDismissals(
    kv["duplicateDismissals"] ?? "",
  );
  return settings;
}

/** Parse the stored dismissal list (a JSON array of pair keys). */
function parseDuplicateDismissals(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
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
      key: "duplicateDismissals",
      value: JSON.stringify(settings.duplicateDismissals),
    },
  ];
  await prisma.$transaction([
    prisma.settings.deleteMany({ where: { accountId } }),
    prisma.settings.createMany({ data: rows }),
  ]);
}

/**
 * Mark an expense pair as "not a duplicate" so the warning never shows for
 * it again. The key is order-independent, so dismissing works no matter
 * which side of the pair the user acted on. Idempotent.
 */
export async function dismissDuplicatePair(
  accountId: string,
  idA: string,
  idB: string,
): Promise<void> {
  const settings = await readSettings(accountId);
  const key = duplicatePairKey(idA, idB);
  if (settings.duplicateDismissals.includes(key)) return;
  await writeSettings(accountId, {
    ...settings,
    duplicateDismissals: [...settings.duplicateDismissals, key],
  });
}

// --- OAuth (MCP authorization server) -------------------------------------

/**
 * Register an OAuth client (RFC 7591 dynamic registration). The raw client
 * secret is never stored — only its SHA-256 hash. Returns the record; the
 * caller hands the secret to the client exactly once.
 */
export async function registerOAuthClient(input: {
  id: string;
  secretHash: string | null;
  name: string;
  redirectUris: string[];
  authMethod: OAuthClientRecord["authMethod"];
}): Promise<OAuthClientRecord> {
  const client: OAuthClientRecord = {
    id: input.id,
    secretHash: input.secretHash,
    name: input.name,
    redirectUris: input.redirectUris,
    authMethod: input.authMethod,
    createdAt: new Date().toISOString(),
  };
  await prisma.oAuthClient.create({
    data: {
      id: client.id,
      secretHash: client.secretHash,
      name: client.name,
      redirectUris: JSON.stringify(client.redirectUris),
      authMethod: client.authMethod,
      createdAt: client.createdAt,
    },
  });
  return client;
}

/** Look up a registered OAuth client, or undefined when unknown. */
export async function findOAuthClient(
  clientId: string,
): Promise<OAuthClientRecord | undefined> {
  const row = await prisma.oAuthClient.findUnique({ where: { id: clientId } });
  if (!row) return undefined;
  return oauthClientFromRow(row);
}

/** Record that a user approved a client (idempotent). */
export async function saveOAuthConsent(
  userId: string,
  clientId: string,
): Promise<void> {
  await prisma.oAuthConsent.upsert({
    where: { userId_clientId: { userId, clientId } },
    update: { grantedAt: new Date().toISOString() },
    create: {
      userId,
      clientId,
      grantedAt: new Date().toISOString(),
    },
  });
}

/** True when the user already approved this client. */
export async function hasOAuthConsent(
  userId: string,
  clientId: string,
): Promise<boolean> {
  const row = await prisma.oAuthConsent.findUnique({
    where: { userId_clientId: { userId, clientId } },
    select: { userId: true },
  });
  return row !== null;
}

/** Store an authorization code (id is the sha256 of the raw code). */
export async function createOAuthCode(input: {
  id: string;
  userId: string;
  clientId: string;
  challenge: string;
  redirectUri: string;
  expiresAt: string;
}): Promise<void> {
  await prisma.oAuthCode.create({
    data: {
      ...input,
      used: false,
      createdAt: new Date().toISOString(),
    },
  });
}

/**
 * Claim a code for exchange: marks it used atomically (single-use) and
 * returns it, or undefined when the code is unknown, already used, or
 * expired. The `used: false` predicate makes the claim race-safe.
 */
export async function consumeOAuthCode(
  id: string,
  clientId: string,
): Promise<OAuthCodeRecord | undefined> {
  const claimed = await prisma.oAuthCode.updateMany({
    where: {
      id,
      clientId,
      used: false,
      expiresAt: { gt: new Date().toISOString() },
    },
    data: { used: true },
  });
  if (claimed.count === 0) return undefined;
  const row = await prisma.oAuthCode.findUnique({ where: { id } });
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.userId,
    clientId: row.clientId,
    challenge: row.challenge,
    redirectUri: row.redirectUri,
    expiresAt: row.expiresAt,
  };
}

/** Store an access or refresh token; also sweeps expired rows (cheap). */
export async function createOAuthToken(input: {
  tokenHash: string;
  userId: string;
  clientId: string;
  type: OAuthTokenRecord["type"];
  scope: string;
  expiresAt: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await prisma.$transaction([
    prisma.oAuthCode.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.oAuthToken.deleteMany({
      where: { expiresAt: { lt: now }, revokedAt: null },
    }),
    prisma.oAuthToken.create({
      data: { ...input, revokedAt: null, createdAt: now },
    }),
  ]);
}

/** Look up a token by its stored hash. */
export async function findOAuthToken(
  tokenHash: string,
): Promise<OAuthTokenRecord | undefined> {
  const row = await prisma.oAuthToken.findUnique({ where: { tokenHash } });
  if (!row) return undefined;
  return oauthTokenFromRow(row);
}

/** Mark a token revoked (refresh rotation, disconnect, revocation endpoint). */
export async function revokeOAuthToken(tokenHash: string): Promise<void> {
  await prisma.oAuthToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date().toISOString() },
  });
}

/**
 * The OAuth clients this user has connected, with activity summary — the
 * Settings → Agents & API "connected apps" list. Individual tokens are not
 * exposed here: the UI shows the app, when it was last used (the most recent
 * token issuance for this client — access tokens are minted on every
 * session/refresh), and when its access expires (the furthest expiry among
 * still-active tokens; null when the connection has no live tokens).
 */
export async function listUserOAuthSessions(userId: string): Promise<
  {
    client: OAuthClientRecord;
    lastUsedAt: string | null;
    expiresAt: string | null;
  }[]
> {
  const consents = await prisma.oAuthConsent.findMany({
    where: { userId },
    orderBy: { grantedAt: "desc" },
    select: { clientId: true },
  });
  if (consents.length === 0) return [];
  const [clients, tokens] = await Promise.all([
    prisma.oAuthClient.findMany({
      where: { id: { in: consents.map((c) => c.clientId) } },
    }),
    prisma.oAuthToken.findMany({ where: { userId } }),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const now = new Date().toISOString();
  const out: {
    client: OAuthClientRecord;
    lastUsedAt: string | null;
    expiresAt: string | null;
  }[] = [];
  for (const consent of consents) {
    const row = clientById.get(consent.clientId);
    if (!row) continue;
    const own = tokens.filter((t) => t.clientId === consent.clientId);
    const lastUsedAt = own.reduce<string | null>(
      (latest, t) => (t.createdAt > (latest ?? "") ? t.createdAt : latest),
      null,
    );
    const active = own.filter((t) => t.revokedAt === null && t.expiresAt > now);
    const expiresAt = active.reduce<string | null>(
      (latest, t) => (t.expiresAt > (latest ?? "") ? t.expiresAt : latest),
      null,
    );
    out.push({ client: oauthClientFromRow(row), lastUsedAt, expiresAt });
  }
  return out;
}

/** Delete a registered OAuth client entirely (cascades codes/tokens/consents). */
export async function deleteOAuthClient(clientId: string): Promise<void> {
  await prisma.oAuthClient.deleteMany({ where: { id: clientId } });
}

/**
 * Disconnect a client: revoke every live token for this user + client and
 * drop the consent. The client's next token use is rejected.
 */
export async function disconnectOAuthClient(
  userId: string,
  clientId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.oAuthToken.updateMany({
      where: { userId, clientId, revokedAt: null },
      data: { revokedAt: new Date().toISOString() },
    }),
    prisma.oAuthConsent.deleteMany({ where: { userId, clientId } }),
  ]);
}

function oauthClientFromRow(row: {
  id: string;
  secretHash: string | null;
  name: string;
  redirectUris: string;
  authMethod: string;
  createdAt: string;
}): OAuthClientRecord {
  let redirectUris: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.redirectUris);
    if (Array.isArray(parsed)) {
      redirectUris = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // malformed stored JSON — treat as no redirect URIs
  }
  return {
    id: row.id,
    secretHash: row.secretHash,
    name: row.name,
    redirectUris,
    authMethod:
      row.authMethod === "client_secret_basic" ? "client_secret_basic" : "none",
    createdAt: row.createdAt,
  };
}

function oauthTokenFromRow(row: {
  tokenHash: string;
  userId: string;
  clientId: string;
  type: string;
  scope: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}): OAuthTokenRecord {
  return {
    tokenHash: row.tokenHash,
    userId: row.userId,
    clientId: row.clientId,
    type: row.type === "refresh" ? "refresh" : "access",
    scope: row.scope,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

// --- Inbound email ----------------------------------------------------------

/** Normalize a sender address for storage/lookup (trim + lowercase). */
/** Trim, strip "Name <addr>" display-name wrapping, lowercase. */
function normalizeSender(address: string): string {
  const trimmed = address.trim();
  const m = trimmed.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  const candidate = m ? m[1]! : trimmed;
  return candidate.toLowerCase();
}

/** The stored row for a received email, or undefined when first seen. */
export async function readInboundEmail(
  emailId: string,
): Promise<InboundEmailRecord | undefined> {
  const row = await prisma.inboundEmail.findUnique({ where: { emailId } });
  return (row ?? undefined) as InboundEmailRecord | undefined;
}

/** Create or update the audit row for a received email. */
export async function upsertInboundEmail(input: {
  emailId: string;
  accountId: string;
  subject: string;
  status: InboundEmailRecord["status"];
  error: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await prisma.inboundEmail.upsert({
    where: { emailId: input.emailId },
    update: {
      accountId: input.accountId,
      subject: input.subject,
      status: input.status,
      error: input.error,
      updatedAt: now,
    },
    create: { ...input, createdAt: now, updatedAt: now },
  });
}

/**
 * The account that verified this sender address — the exclusivity owner.
 * Only verified addresses accept receipts; see InboundSenderVerification.
 * Undefined when no account has verified the address.
 */
export async function findVerifiedSenderAccount(
  senderEmail: string,
): Promise<{ account: Account; verifiedAt: string } | undefined> {
  const address = normalizeSender(senderEmail);
  if (!address) return undefined;
  const verification = await prisma.inboundSenderVerification.findUnique({
    where: { address },
  });
  if (!verification) return undefined;
  const account = await prisma.account.findUnique({
    where: { id: verification.accountId },
  });
  if (!account) return undefined;
  return { account, verifiedAt: verification.verifiedAt };
}

/**
 * A pending (added-but-unverified) sender row for an address, if any. Used
 * by the inbound pipeline to tell "verify first" from "not recognized".
 */
export async function findPendingSenderRow(
  senderEmail: string,
): Promise<{ accountId: string; address: string } | undefined> {
  const address = normalizeSender(senderEmail);
  if (!address) return undefined;
  const row = await prisma.inboundSender.findFirst({
    where: { address },
    orderBy: [{ createdAt: "asc" }, { accountId: "asc" }],
    select: { accountId: true, address: true },
  });
  return row ?? undefined;
}

/**
 * All sender addresses for an account, in the order they were added, with
 * their verified status (a sender is verified when an
 * inbound_sender_verifications row exists for the address).
 */
export async function listInboundSenders(
  accountId: string,
): Promise<InboundSenderRecord[]> {
  const rows = await prisma.inboundSender.findMany({
    where: { accountId },
    orderBy: [{ createdAt: "asc" }, { address: "asc" }],
  });
  const verifications = await prisma.inboundSenderVerification.findMany({
    where: { accountId },
  });
  const byAddress = new Map(verifications.map((v) => [v.address, v]));
  return rows.map((r) => ({
    accountId: r.accountId,
    address: r.address,
    verified: byAddress.has(r.address),
    verifiedAt: byAddress.get(r.address)?.verifiedAt ?? null,
    verificationSentAt: r.verificationSentAt,
    createdAt: r.createdAt,
  }));
}

/**
 * Add a sender address for an account (normalized, idempotent) and mint a
 * fresh verification token for it. The address is only usable once verified
 * — and only one account can verify it. Returns the token so the caller
 * emails the verification link; `token: null` means the address was already
 * verified for this account (nothing to send). Fails when the address is
 * already verified for a different account.
 */
export async function addInboundSender(
  accountId: string,
  address: string,
): Promise<
  | { ok: true; address: string; token: string | null }
  | { ok: false; error: string }
> {
  const normalized = normalizeSender(address);
  if (!normalized || !isEmail(normalized)) {
    return { ok: false, error: "Enter a valid email address" };
  }
  const verification = await prisma.inboundSenderVerification.findUnique({
    where: { address: normalized },
  });
  if (verification && verification.accountId !== accountId) {
    return {
      ok: false,
      error: "That email address is already verified for another account",
    };
  }
  if (verification) return { ok: true, address: normalized, token: null };
  const token = generateVerificationToken();
  const now = new Date().toISOString();
  await prisma.inboundSender.upsert({
    where: { accountId_address: { accountId, address: normalized } },
    update: {
      verificationTokenHash: hashVerificationToken(token),
      verificationSentAt: now,
    },
    create: {
      accountId,
      address: normalized,
      verificationTokenHash: hashVerificationToken(token),
      verificationSentAt: now,
      createdAt: now,
    },
  });
  return { ok: true, address: normalized, token };
}

/**
 * Mint a fresh verification token for an already-added sender (the "Resend
 * verification email" action). Fails when the address is already verified
 * or claimed by another account.
 */
export async function resendInboundSenderVerification(
  accountId: string,
  address: string,
): Promise<
  { ok: true; address: string; token: string } | { ok: false; error: string }
> {
  const normalized = normalizeSender(address);
  if (!normalized) return { ok: false, error: "Enter a valid email address" };
  const verification = await prisma.inboundSenderVerification.findUnique({
    where: { address: normalized },
  });
  if (verification) {
    return {
      ok: false,
      error:
        verification.accountId === accountId
          ? "That address is already verified"
          : "That email address is already verified for another account",
    };
  }
  const token = generateVerificationToken();
  const now = new Date().toISOString();
  await prisma.inboundSender.upsert({
    where: { accountId_address: { accountId, address: normalized } },
    update: {
      verificationTokenHash: hashVerificationToken(token),
      verificationSentAt: now,
    },
    create: {
      accountId,
      address: normalized,
      verificationTokenHash: hashVerificationToken(token),
      verificationSentAt: now,
      createdAt: now,
    },
  });
  return { ok: true, address: normalized, token };
}

/** Remove a sender address (and its verification) from an account. */
export async function removeInboundSender(
  accountId: string,
  address: string,
): Promise<void> {
  const normalized = normalizeSender(address);
  await prisma.$transaction([
    prisma.inboundSender.deleteMany({
      where: { accountId, address: normalized },
    }),
    prisma.inboundSenderVerification.deleteMany({
      where: { accountId, address: normalized },
    }),
  ]);
}

/** The outcome of clicking a verification link (see verifyInboundSenderAddress). */
export type VerifySenderOutcome =
  | {
      status: "verified";
      address: string;
      accountId: string;
      accountName: string;
    }
  | {
      status: "already-verified";
      address: string;
      accountId: string;
      accountName: string;
    }
  | { status: "expired"; address: string }
  | { status: "invalid" };

/**
 * Verify a sender address from its emailed token. Single-use, 7-day expiry,
 * and exclusive: verifying claims the address for this account (the
 * verification row's primary key rejects a second claim) and deletes every
 * other account's pending rows for it. The token is consumed regardless, so
 * a stale link can't be replayed.
 */
export async function verifyInboundSenderAddress(
  rawToken: string,
): Promise<VerifySenderOutcome> {
  if (!rawToken) return { status: "invalid" };
  const row = await prisma.inboundSender.findFirst({
    where: { verificationTokenHash: hashVerificationToken(rawToken) },
  });
  if (!row) return { status: "invalid" };
  const sentAt = row.verificationSentAt
    ? Date.parse(row.verificationSentAt)
    : 0;
  if (!Number.isFinite(sentAt) || Date.now() - sentAt > VERIFICATION_TTL_MS) {
    return { status: "expired", address: row.address };
  }
  const account = await prisma.account.findUnique({
    where: { id: row.accountId },
  });
  const accountName = account?.name ?? "";
  try {
    await prisma.$transaction([
      // The primary key on address makes a second verified claim impossible.
      prisma.inboundSenderVerification.create({
        data: {
          address: row.address,
          accountId: row.accountId,
          verifiedAt: new Date().toISOString(),
        },
      }),
      // The address is now exclusively this account's — drop rivals' pending rows.
      prisma.inboundSender.deleteMany({
        where: { address: row.address, accountId: { not: row.accountId } },
      }),
      // Consume the token.
      prisma.inboundSender.update({
        where: {
          accountId_address: { accountId: row.accountId, address: row.address },
        },
        data: { verificationTokenHash: null },
      }),
    ]);
  } catch (err) {
    // P2002 — another account verified the address first (race).
    if ((err as { code?: string } | null)?.code === "P2002") {
      return {
        status: "already-verified",
        address: row.address,
        accountId: row.accountId,
        accountName,
      };
    }
    throw err;
  }
  return {
    status: "verified",
    address: row.address,
    accountId: row.accountId,
    accountName,
  };
}

/**
 * Guarantee the account's login email is a sender row (the "default"
 * receipts-by-email address). Creates it pending when missing and mints a
 * verification token; called on signup, join, and every sign-in. A token is
 * returned (send the verification email now) when the row was just created
 * or the last verification email is stale (>24h). `verified` reports an
 * already-verified own row; `claimedByOther` means the address is verified
 * for a different account (the login email can't be claimed — the mailbox
 * owner verified it elsewhere first).
 */
export async function ensureInboundSenderForUser(
  accountId: string,
  email: string,
): Promise<{
  token: string | null;
  verified: boolean;
  claimedByOther: boolean;
}> {
  const address = normalizeSender(email);
  if (!address) return { token: null, verified: false, claimedByOther: false };
  const verification = await prisma.inboundSenderVerification.findUnique({
    where: { address },
  });
  if (verification) {
    return {
      token: null,
      verified: verification.accountId === accountId,
      claimedByOther: verification.accountId !== accountId,
    };
  }
  const existing = await prisma.inboundSender.findUnique({
    where: { accountId_address: { accountId, address } },
  });
  if (existing?.verificationTokenHash) {
    const sentAt = existing.verificationSentAt
      ? Date.parse(existing.verificationSentAt)
      : 0;
    if (
      Number.isFinite(sentAt) &&
      Date.now() - sentAt < VERIFICATION_RESEND_MS
    ) {
      // A fresh verification email is already in flight — don't re-send.
      return { token: null, verified: false, claimedByOther: false };
    }
  }
  const token = generateVerificationToken();
  const now = new Date().toISOString();
  await prisma.inboundSender.upsert({
    where: { accountId_address: { accountId, address } },
    update: {
      verificationTokenHash: hashVerificationToken(token),
      verificationSentAt: now,
    },
    create: {
      accountId,
      address,
      verificationTokenHash: hashVerificationToken(token),
      verificationSentAt: now,
      createdAt: now,
    },
  });
  return { token, verified: false, claimedByOther: false };
}

/** A fresh single-use verification token (base64url) and its sha256 hash. */
function generateVerificationToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashVerificationToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Verification links expire 7 days after the email is sent. */
const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Don't auto-re-send a verification email for one address more than once a day. */
const VERIFICATION_RESEND_MS = 24 * 60 * 60 * 1000;

// --- Helpers ---------------------------------------------------------------

/** Delete the stored images of receipt expenses, best-effort (image rows
 * may already be gone). Used when expenses are deleted wholesale. */
async function deleteReceiptImages(
  accountId: string,
  expenses: readonly { type: string; imageFile?: string }[],
): Promise<void> {
  for (const e of expenses) {
    if (e.type === "receipt" && e.imageFile) {
      await deleteImage(accountId, e.imageFile).catch(() => {});
    }
  }
}

/** Expense fields for create/update, split by type. */
function expenseData(
  e: Expense,
): Omit<Prisma.ExpenseCreateManyInput, "accountId"> {
  const common = {
    id: e.id,
    type: e.type,
    date: e.date,
    report: e.report,
    category: e.category,
    description: e.description,
    // "" is the domain's "no amount" sentinel → NULL (nullable Decimal).
    amount: e.amount === "" ? null : e.amount,
    mileageType: e.type === "mileage" ? e.mileageType : "business",
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
  if (e.type === "receipt") {
    return {
      ...common,
      merchant: e.merchant,
      imageFile: e.imageFile,
      imageMime: e.imageMime,
      originalName: e.originalName,
      distanceMiles: null,
      locations: [],
      route: undefined,
    };
  }
  return {
    ...common,
    merchant: "",
    imageFile: "",
    imageMime: "",
    originalName: "",
    distanceMiles: e.distanceMiles === "" ? null : e.distanceMiles,
    locations: e.locations as unknown as Prisma.InputJsonValue,
    route: e.route as unknown as Prisma.InputJsonValue,
  };
}

function rowToExpense(row: {
  id: string;
  type: string;
  date: string;
  report: string;
  category: string;
  description: string;
  amount: Prisma.Decimal | null;
  merchant: string;
  imageFile: string;
  imageMime: string;
  originalName: string;
  distanceMiles: Prisma.Decimal | null;
  mileageType: string;
  locations: unknown;
  route: unknown;
  createdAt: string;
  updatedAt: string;
}): Expense {
  const base = {
    id: row.id,
    type: row.type as Expense["type"],
    date: row.date ?? "",
    report: row.report ?? "",
    category: row.category ?? "",
    description: row.description ?? "",
    // Decimal → 2-dp string (the domain's "" means no amount). toFixed(2) is
    // a lossless pad: numeric(10,2) already stores exactly two digits.
    amount: row.amount?.toFixed(2) ?? "",
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
  if (base.type === "receipt") {
    const receipt: ReceiptExpense = {
      ...base,
      type: "receipt",
      merchant: row.merchant ?? "",
      imageFile: row.imageFile ?? "",
      imageMime: row.imageMime ?? "",
      originalName: row.originalName ?? "",
    };
    return receipt;
  }
  const mileage: MileageExpense = {
    ...base,
    type: "mileage",
    // Legacy rows predate the type column — they are business trips.
    mileageType: isMileageType(row.mileageType) ? row.mileageType : "business",
    locations: parseLocations(row.locations),
    distanceMiles: row.distanceMiles?.toFixed(2) ?? "",
    route: parseRoute(row.route),
  };
  return mileage;
}
