import { ulid } from "ulid";
import { APP_PASSWORD, APP_USERNAME } from "~/lib/env";
import { deleteImage } from "~/lib/images.server";
import { generateInviteCode, hashPassword } from "~/lib/passwords";
import prisma from "~/lib/prisma.server";
import type { Prisma } from "prisma/generated";
import { DEFAULT_SETTINGS } from "~/lib/types";
import type {
  Account,
  Category,
  Expense,
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

let ready: Promise<void> | undefined;

/** One-time (per process) data seeding: bootstrap user + adopt legacy rows. */
export async function initStore(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const bootstrap = await ensureBootstrapUser();
      await prisma.expense.updateMany({
        where: { accountId: "" },
        data: { accountId: bootstrap.accountId },
      });
      await prisma.report.updateMany({
        where: { accountId: "" },
        data: { accountId: bootstrap.accountId },
      });
      await prisma.category.updateMany({
        where: { accountId: "" },
        data: { accountId: bootstrap.accountId },
      });
      await prisma.mileage.updateMany({
        where: { accountId: "" },
        data: { accountId: bootstrap.accountId },
      });
      await prisma.settings.updateMany({
        where: { accountId: "" },
        data: { accountId: bootstrap.accountId },
      });
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
  if (first) return rowToUser(first);

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

function rowToAccount(row: Account): Account {
  return row;
}

function rowToUser(row: User): User {
  return row;
}

export async function readAccount(id: string): Promise<Account | undefined> {
  const row = await prisma.account.findUnique({ where: { id } });
  return row ? rowToAccount(row) : undefined;
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
  await prisma.account.create({ data: account });
  return account;
}

export async function findAccountByInviteCode(
  inviteCode: string,
): Promise<Account | undefined> {
  const row = await prisma.account.findUnique({ where: { inviteCode } });
  return row ? rowToAccount(row) : undefined;
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
  return row ? rowToUser(row) : undefined;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const row = await prisma.user.findUnique({ where: { id } });
  return row ? rowToUser(row) : undefined;
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

export async function writeExpenses(
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
          distanceMiles: e.distanceMiles,
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
  if (target?.type === "receipt" && target.imageFile) {
    await deleteImage(accountId, target.imageFile).catch(() => {});
  }
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

export async function readReports(accountId: string): Promise<Report[]> {
  const rows = await prisma.report.findMany({
    where: { accountId, name: { not: "" } },
    orderBy: { id: "asc" },
    select: { name: true },
  });
  return rows.map((r) => ({ name: r.name }));
}

export async function writeReports(
  accountId: string,
  reports: Report[],
): Promise<void> {
  await prisma.$transaction([
    prisma.report.deleteMany({ where: { accountId } }),
    prisma.report.createMany({
      data: reports.map((r) => ({ name: r.name, accountId })),
      skipDuplicates: true,
    }),
  ]);
}

export async function addReport(
  accountId: string,
  name: string,
): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  await prisma.report.createMany({
    data: [{ name: clean, accountId }],
    skipDuplicates: true,
  });
}

export async function removeReport(
  accountId: string,
  name: string,
): Promise<void> {
  await prisma.report.deleteMany({ where: { accountId, name } });
}

export async function renameReport(
  accountId: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const clean = newName.trim();
  if (!clean || oldName === clean) return;
  await prisma.$transaction(async (tx) => {
    const clash = await tx.report.findFirst({
      where: { accountId, name: clean, NOT: { name: oldName } },
      select: { id: true },
    });
    if (clash) return;
    await tx.report.updateMany({
      where: { accountId, name: oldName },
      data: { name: clean },
    });
    await tx.expense.updateMany({
      where: { accountId, report: oldName },
      data: { report: clean },
    });
  });
}

export async function readCategories(accountId: string): Promise<Category[]> {
  const rows = await prisma.category.findMany({
    where: { accountId, name: { not: "" } },
    orderBy: { id: "asc" },
    select: { name: true },
  });
  return rows.map((c) => ({ name: c.name }));
}

export async function writeCategories(
  accountId: string,
  categories: Category[],
): Promise<void> {
  await prisma.$transaction([
    prisma.category.deleteMany({ where: { accountId } }),
    prisma.category.createMany({
      data: categories.map((c) => ({ name: c.name, accountId })),
      skipDuplicates: true,
    }),
  ]);
}

export async function addCategory(
  accountId: string,
  name: string,
): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  await prisma.category.createMany({
    data: [{ name: clean, accountId }],
    skipDuplicates: true,
  });
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

// --- Helpers ---------------------------------------------------------------

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
    amount: e.amount,
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
      distanceMiles: "",
      locations: [],
    };
  }
  return {
    ...common,
    merchant: "",
    imageFile: "",
    imageMime: "",
    originalName: "",
    distanceMiles: e.distanceMiles,
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
  amount: string;
  merchant: string;
  imageFile: string;
  imageMime: string;
  originalName: string;
  distanceMiles: string;
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
    amount: row.amount ?? "",
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
    distanceMiles: row.distanceMiles ?? "",
  };
  return mileage;
}

function parseLocations(raw: unknown): MileageExpense["locations"] {
  if (Array.isArray(raw)) {
    return raw
      .filter(
        (v): v is { address: string; lat: number | null; lng: number | null } =>
          v && typeof v === "object" && "address" in v,
      )
      .map((v) => ({
        address: typeof v.address === "string" ? v.address : "",
        lat: typeof v.lat === "number" ? v.lat : null,
        lng: typeof v.lng === "number" ? v.lng : null,
      }));
  }
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parseLocations(parsed);
  } catch {
    return [];
  }
}
