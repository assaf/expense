import { ulid } from "ulid";
import { APP_PASSWORD, APP_USERNAME } from "~/lib/env";
import { deleteImage } from "~/lib/images.server";
import { generateInviteCode, hashPassword } from "~/lib/passwords";
import prisma from "~/lib/prisma.server";
import type { Prisma } from "prisma/generated";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  parseLocations,
} from "~/lib/types";
import type {
  Account,
  Category,
  Expense,
  InboundEmailRecord,
  MileageExpense,
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
 * bootstraps the first account/user from APP_USERNAME/APP_PASSWORD and
 * adopts single-user era rows (accountId '') into that account.
 */

/** The subset of Prisma delegates that carry legacy accountId "" rows. */
interface AccountAdopter {
  updateMany(args: {
    where: { accountId: string };
    data: { accountId: string };
  }): Promise<unknown>;
}

let ready: Promise<void> | undefined;

/** One-time (per process) data seeding: bootstrap user + adopt legacy rows. */
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
    })().catch((error) => {
      // Allow a retry on the next call if seeding failed partway.
      ready = undefined;
      throw error;
    });
  }
  await ready;
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
 * bootstrap account + user from APP_USERNAME/APP_PASSWORD (fail-closed if
 * missing). Otherwise returns the oldest existing user — used as the target
 * account for adopting legacy (pre-account) rows.
 */
async function ensureBootstrapUser(): Promise<User> {
  const first = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (first) return first;

  if (!APP_USERNAME || !APP_PASSWORD) {
    throw new Error(
      "No users exist and APP_USERNAME/APP_PASSWORD are not configured — " +
        "set them to create the first account and user.",
    );
  }

  const now = new Date().toISOString();
  const accountId = ulid();
  const userId = ulid();
  await prisma.$transaction([
    prisma.account.create({
      data: {
        id: accountId,
        name: APP_USERNAME.trim(),
        inviteCode: generateInviteCode(),
        createdAt: now,
      },
    }),
    prisma.user.create({
      data: {
        id: userId,
        accountId,
        username: APP_USERNAME.trim().toLowerCase(),
        passwordHash: await hashPassword(APP_PASSWORD),
        name: APP_USERNAME.trim(),
        createdAt: now,
      },
    }),
    prisma.category.createMany({
      data: DEFAULT_CATEGORIES.map((name) => ({ name, accountId })),
      skipDuplicates: true,
    }),
  ]);
  return {
    id: userId,
    accountId,
    username: APP_USERNAME.trim().toLowerCase(),
    name: APP_USERNAME.trim(),
    createdAt: now,
  };
}

// --- Accounts & Users ------------------------------------------------------

export async function readAccount(id: string): Promise<Account | undefined> {
  const row = await prisma.account.findUnique({ where: { id } });
  return row ?? undefined;
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
    prisma.category.createMany({
      data: DEFAULT_CATEGORIES.map((name) => ({ name, accountId: account.id })),
      skipDuplicates: true,
    }),
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

/** Create a user in an account. Throws if the username is already taken. */
export async function createUser(input: {
  accountId: string;
  username: string;
  passwordHash: string;
  name: string;
}): Promise<User> {
  await initStore();
  const username = input.username.trim().toLowerCase();
  if (!username) throw new Error("Username is required");
  const clash = await prisma.user.findUnique({ where: { username } });
  if (clash) throw new Error("That username is already taken");
  const user: User = {
    id: ulid(),
    accountId: input.accountId,
    username,
    name: input.name.trim() || username,
    createdAt: new Date().toISOString(),
  };
  await prisma.user.create({
    data: { ...user, passwordHash: input.passwordHash },
  });
  return user;
}

export async function findUserByUsername(
  username: string,
): Promise<User | undefined> {
  const row = await prisma.user.findUnique({
    where: { username: username.trim().toLowerCase() },
  });
  return row ?? undefined;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const row = await prisma.user.findUnique({ where: { id } });
  return row ?? undefined;
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
  const settings: Settings = { ...DEFAULT_SETTINGS, mileageRates: {} };
  const kv: Record<string, string> = {};
  for (const row of rows) {
    if (row.key) kv[row.key] = row.value;
  }
  settings.homeAddress = kv["homeAddress"] ?? "";
  settings.homeLat = kv["homeLat"] ? Number(kv["homeLat"]) : null;
  settings.homeLng = kv["homeLng"] ? Number(kv["homeLng"]) : null;
  for (const [k, v] of Object.entries(kv)) {
    const m = k.match(/^mileageRate\.(.+)$/);
    if (m && v) settings.mileageRates[m[1]] = v;
  }
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
  ];
  for (const [year, rate] of Object.entries(settings.mileageRates)) {
    rows.push({ accountId, key: `mileageRate.${year}`, value: rate });
  }
  await prisma.$transaction([
    prisma.settings.deleteMany({ where: { accountId } }),
    prisma.settings.createMany({ data: rows }),
  ]);
}

// --- Inbound email ----------------------------------------------------------

/** Normalize a sender address for storage/lookup (trim + lowercase). */
function normalizeSender(address: string): string {
  return address.trim().toLowerCase();
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
  const existing = await prisma.inboundEmail.findUnique({
    where: { emailId: input.emailId },
  });
  if (existing) {
    await prisma.inboundEmail.update({
      where: { emailId: input.emailId },
      data: {
        accountId: input.accountId,
        subject: input.subject,
        status: input.status,
        error: input.error,
        updatedAt: now,
      },
    });
  } else {
    await prisma.inboundEmail.create({
      data: { ...input, createdAt: now, updatedAt: now },
    });
  }
}

/**
 * The account that claims this sender address, by "first added" precedence:
 * when the same address is allowed by several accounts, the row with the
 * earliest createdAt wins; removing that row falls through to the next one.
 */
export async function findAccountByInboundSender(
  senderEmail: string,
): Promise<Account | undefined> {
  const target = normalizeSender(senderEmail);
  if (!target) return undefined;
  const rows = await prisma.inboundSender.findMany({
    where: { address: target },
    orderBy: [{ createdAt: "asc" }, { accountId: "asc" }],
    select: { accountId: true },
  });
  for (const row of rows) {
    const account = await prisma.account.findUnique({
      where: { id: row.accountId },
    });
    if (account) return account;
  }
  return undefined;
}

/** All allowed sender addresses for an account, in the order they were added. */
export async function listInboundSenders(accountId: string): Promise<string[]> {
  const rows = await prisma.inboundSender.findMany({
    where: { accountId },
    orderBy: [{ createdAt: "asc" }, { address: "asc" }],
    select: { address: true },
  });
  return rows.map((r) => r.address);
}

/** Allow a sender address for an account (idempotent, normalized). */
export async function addInboundSender(
  accountId: string,
  address: string,
): Promise<void> {
  const normalized = normalizeSender(address);
  if (!normalized) return;
  await prisma.inboundSender.createMany({
    data: [
      { accountId, address: normalized, createdAt: new Date().toISOString() },
    ],
    skipDuplicates: true,
  });
}

/** Remove a sender address from an account. */
export async function removeInboundSender(
  accountId: string,
  address: string,
): Promise<void> {
  await prisma.inboundSender.deleteMany({
    where: { accountId, address: normalizeSender(address) },
  });
}

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
  locations: unknown;
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
    locations: parseLocations(row.locations),
    distanceMiles: row.distanceMiles?.toFixed(2) ?? "",
  };
  return mileage;
}
