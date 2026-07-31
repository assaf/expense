import postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";
import { ulid } from "ulid";
import { APP_PASSWORD, APP_USERNAME, DATABASE_URL } from "~/lib/env";
import { deleteImage } from "~/lib/images.server";
import { generateInviteCode, hashPassword } from "~/lib/passwords";
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
 * Postgres-backed store — the only storage backend. DATABASE_URL is required;
 * all accounts/users/expenses/reports/categories/settings/mileage/image-blob
 * reads and writes go through here (see app/lib/store.server.ts).
 *
 * Every domain row belongs to an account (`accountId`); all reads and writes
 * are scoped to the caller's account so users only ever see their own
 * account's data. Multiple users may belong to one account and share its
 * expenses, reports, categories, and settings.
 */

let sql: Sql | undefined;
let schemaReady: Promise<void> | undefined;

function db(): Sql {
  if (!sql) {
    if (!DATABASE_URL) throw new Error("DATABASE_URL is not configured");
    sql = postgres(DATABASE_URL, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return sql;
}

// Tables created on first use. Legacy single-user tables are upgraded by
// migrateSchema() below (accountId columns, per-account uniqueness, FKs).
const DDL = `
CREATE TABLE IF NOT EXISTS accounts (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "inviteCode" TEXT NOT NULL UNIQUE,
  "createdAt" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS users (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "username" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL DEFAULT '',
  "name" TEXT NOT NULL DEFAULT '',
  "createdAt" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS expenses (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL DEFAULT '',
  "date" TEXT NOT NULL DEFAULT '',
  "report" TEXT NOT NULL DEFAULT '',
  "category" TEXT NOT NULL DEFAULT '',
  "description" TEXT NOT NULL DEFAULT '',
  "amount" TEXT NOT NULL DEFAULT '',
  "merchant" TEXT NOT NULL DEFAULT '',
  "imageFile" TEXT NOT NULL DEFAULT '',
  "imageMime" TEXT NOT NULL DEFAULT '',
  "originalName" TEXT NOT NULL DEFAULT '',
  "distanceMiles" TEXT NOT NULL DEFAULT '',
  "locations" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TEXT NOT NULL DEFAULT '',
  "updatedAt" TEXT NOT NULL DEFAULT '',
  "accountId" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS reports (
  "id" BIGSERIAL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "accountId" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS categories (
  "id" BIGSERIAL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "accountId" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS mileage (
  "date" TEXT NOT NULL DEFAULT '',
  "report" TEXT NOT NULL DEFAULT '',
  "locations" TEXT NOT NULL DEFAULT '',
  "distanceMiles" TEXT NOT NULL DEFAULT '',
  "accountId" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS "settings" (
  "accountId" TEXT NOT NULL DEFAULT '',
  "key" TEXT NOT NULL DEFAULT '',
  "value" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS image_blobs (
  "key" TEXT PRIMARY KEY,
  "mime" TEXT NOT NULL DEFAULT '',
  "data" BYTEA NOT NULL
);
`;

/**
 * Create tables, migrate the single-user schema to per-account, and bootstrap
 * the first account/user. Idempotent and memoized per process — runs on first
 * use in every process (dev, tests, production).
 */
export async function initStore(): Promise<void> {
  if (!schemaReady) {
    schemaReady = migrateSchema();
  }
  await schemaReady;
}

async function migrateSchema(): Promise<void> {
  await db().unsafe(DDL);

  // Legacy tables get an account column (default '' until adopted below).
  await db().unsafe(`
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS "accountId" TEXT NOT NULL DEFAULT '';
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS "accountId" TEXT NOT NULL DEFAULT '';
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS "accountId" TEXT NOT NULL DEFAULT '';
    ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "accountId" TEXT NOT NULL DEFAULT '';
    ALTER TABLE mileage ADD COLUMN IF NOT EXISTS "accountId" TEXT NOT NULL DEFAULT '';
  `);

  // First user (from APP_USERNAME/APP_PASSWORD) or the oldest existing one.
  const bootstrap = await ensureBootstrapUser();

  // Adopt single-user era rows (accountId '') into the bootstrap account.
  await db()`UPDATE expenses SET "accountId" = ${bootstrap.accountId} WHERE "accountId" = ''`;
  await db()`UPDATE reports SET "accountId" = ${bootstrap.accountId} WHERE "accountId" = ''`;
  await db()`UPDATE categories SET "accountId" = ${bootstrap.accountId} WHERE "accountId" = ''`;
  await db()`UPDATE mileage SET "accountId" = ${bootstrap.accountId} WHERE "accountId" = ''`;
  await db()`UPDATE "settings" SET "accountId" = ${bootstrap.accountId} WHERE "accountId" = ''`;

  // Reports/categories were globally unique; they are now unique per account.
  await db().unsafe(`
    ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_name_key;
    ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;
    CREATE UNIQUE INDEX IF NOT EXISTS reports_account_name_idx
      ON reports ("accountId", "name");
    CREATE UNIQUE INDEX IF NOT EXISTS categories_account_name_idx
      ON categories ("accountId", "name");
    ALTER TABLE "settings" DROP CONSTRAINT IF EXISTS settings_pkey;
    ALTER TABLE "settings" ADD PRIMARY KEY ("accountId", "key");
  `);

  // Foreign keys (idempotent; added only when missing).
  await db().unsafe(`
    DO $do$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_account_fk') THEN
        ALTER TABLE users ADD CONSTRAINT users_account_fk
          FOREIGN KEY ("accountId") REFERENCES accounts("id") ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_account_fk') THEN
        ALTER TABLE expenses ADD CONSTRAINT expenses_account_fk
          FOREIGN KEY ("accountId") REFERENCES accounts("id") ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_account_fk') THEN
        ALTER TABLE reports ADD CONSTRAINT reports_account_fk
          FOREIGN KEY ("accountId") REFERENCES accounts("id") ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_account_fk') THEN
        ALTER TABLE categories ADD CONSTRAINT categories_account_fk
          FOREIGN KEY ("accountId") REFERENCES accounts("id") ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mileage_account_fk') THEN
        ALTER TABLE mileage ADD CONSTRAINT mileage_account_fk
          FOREIGN KEY ("accountId") REFERENCES accounts("id") ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_account_fk') THEN
        ALTER TABLE "settings" ADD CONSTRAINT settings_account_fk
          FOREIGN KEY ("accountId") REFERENCES accounts("id") ON DELETE CASCADE;
      END IF;
    END $do$;
  `);
}

/**
 * Guarantee at least one user exists. On a fresh database, creates the
 * bootstrap account + user from APP_USERNAME/APP_PASSWORD (fail-closed if
 * those are missing). Otherwise returns the oldest existing user — used only
 * to adopt legacy (pre-account) rows.
 */
async function ensureBootstrapUser(): Promise<User> {
  const users = await db()<
    UserRow[]
  >`SELECT * FROM users ORDER BY "createdAt" LIMIT 1`;
  if (users.length > 0) return rowToUser(users[0]);

  if (!APP_USERNAME || !APP_PASSWORD) {
    throw new Error(
      "No users exist and APP_USERNAME/APP_PASSWORD are not configured — " +
        "set them to create the first account and user.",
    );
  }

  const now = new Date().toISOString();
  const account: Account = {
    id: ulid(),
    name: APP_USERNAME.trim(),
    inviteCode: generateInviteCode(),
    createdAt: now,
  };
  const user: User = {
    id: ulid(),
    accountId: account.id,
    username: APP_USERNAME.trim().toLowerCase(),
    name: APP_USERNAME.trim(),
    createdAt: now,
  };
  const passwordHash = await hashPassword(APP_PASSWORD);
  await db().begin(async (tx) => {
    await tx`INSERT INTO accounts ${tx(account)}`;
    await tx`INSERT INTO users ${tx({ ...user, passwordHash })}`;
  });
  return user;
}

// --- Accounts & Users ------------------------------------------------------

interface AccountRow {
  id: string;
  name: string;
  inviteCode: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  accountId: string;
  username: string;
  passwordHash: string;
  name: string;
  createdAt: string;
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    inviteCode: row.inviteCode,
    createdAt: row.createdAt,
  };
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    accountId: row.accountId,
    username: row.username,
    name: row.name,
    createdAt: row.createdAt,
  };
}

export async function readAccount(id: string): Promise<Account | undefined> {
  await initStore();
  const rows = await db()<
    AccountRow[]
  >`SELECT * FROM accounts WHERE "id" = ${id}`;
  return rows.length > 0 ? rowToAccount(rows[0]) : undefined;
}

/** Create a new account. Throws if the name is already taken. */
export async function createAccount(name: string): Promise<Account> {
  const clean = name.trim();
  if (!clean) throw new Error("Account name is required");
  await initStore();
  const clash = await db()<
    AccountRow[]
  >`SELECT "id" FROM accounts WHERE "name" = ${clean} LIMIT 1`;
  if (clash.length > 0)
    throw new Error("An account with that name already exists");
  const account: Account = {
    id: ulid(),
    name: clean,
    inviteCode: generateInviteCode(),
    createdAt: new Date().toISOString(),
  };
  await db()`INSERT INTO accounts ${db()(account)}`;
  return account;
}

export async function findAccountByInviteCode(
  inviteCode: string,
): Promise<Account | undefined> {
  await initStore();
  const rows = await db()<
    AccountRow[]
  >`SELECT * FROM accounts WHERE "inviteCode" = ${inviteCode} LIMIT 1`;
  return rows.length > 0 ? rowToAccount(rows[0]) : undefined;
}

/** Replace an account's invite code with a fresh one; returns the new code. */
export async function regenerateInviteCode(accountId: string): Promise<string> {
  await initStore();
  const code = generateInviteCode();
  await db()`UPDATE accounts SET "inviteCode" = ${code} WHERE "id" = ${accountId}`;
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
  const clash = await db()<
    UserRow[]
  >`SELECT "id" FROM users WHERE "username" = ${username} LIMIT 1`;
  if (clash.length > 0) throw new Error("That username is already taken");
  const user: User = {
    id: ulid(),
    accountId: input.accountId,
    username,
    name: input.name.trim() || username,
    createdAt: new Date().toISOString(),
  };
  await db()`INSERT INTO users ${db()({ ...user, passwordHash: input.passwordHash })}`;
  return user;
}

export async function findUserByUsername(
  username: string,
): Promise<User | undefined> {
  await initStore();
  const rows = await db()<
    UserRow[]
  >`SELECT * FROM users WHERE "username" = ${username.trim().toLowerCase()} LIMIT 1`;
  return rows.length > 0 ? rowToUser(rows[0]) : undefined;
}

export async function findUserById(id: string): Promise<User | undefined> {
  await initStore();
  const rows = await db()<
    UserRow[]
  >`SELECT * FROM users WHERE "id" = ${id} LIMIT 1`;
  return rows.length > 0 ? rowToUser(rows[0]) : undefined;
}

/** The stored password hash for a user (never exposed on the User type). */
export async function getPasswordHash(userId: string): Promise<string> {
  await initStore();
  const rows = await db()<
    { passwordHash: string }[]
  >`SELECT "passwordHash" FROM users WHERE "id" = ${userId} LIMIT 1`;
  return rows.length > 0 ? rows[0].passwordHash : "";
}

// --- Expenses --------------------------------------------------------------

interface ExpenseRow {
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
}

export async function readExpenses(accountId: string): Promise<Expense[]> {
  await initStore();
  const rows = await db()<
    ExpenseRow[]
  >`SELECT * FROM expenses WHERE "accountId" = ${accountId}`;
  return rows.map(rowToExpense);
}

export async function readExpense(
  id: string,
  accountId: string,
): Promise<Expense | undefined> {
  await initStore();
  const rows = await db()<
    ExpenseRow[]
  >`SELECT * FROM expenses WHERE "id" = ${id} AND "accountId" = ${accountId}`;
  return rows.length > 0 ? rowToExpense(rows[0]) : undefined;
}

export async function writeExpenses(
  accountId: string,
  expenses: Expense[],
): Promise<void> {
  await initStore();
  await db().begin(async (tx) => {
    await tx`DELETE FROM expenses WHERE "accountId" = ${accountId}`;
    for (const e of expenses) {
      await tx`INSERT INTO expenses ${tx({ ...expenseRow(e), accountId })}`;
    }
    await rebuildMileage(tx, accountId, expenses);
  });
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
    await deleteImage(target.imageFile).catch(() => {});
  }
  await writeExpenses(
    accountId,
    all.filter((e) => e.id !== id),
  );
}

/** Distinct merchant names previously used, most-recent first. */
export async function readPriorMerchants(accountId: string): Promise<string[]> {
  await initStore();
  const rows = await db()<
    { merchant: string }[]
  >`SELECT "merchant" FROM expenses WHERE "type" = 'receipt' AND "merchant" <> '' AND "accountId" = ${accountId} GROUP BY "merchant" ORDER BY MAX("createdAt") DESC`;
  return rows.map((r) => r.merchant);
}

// --- Mileage table (derived artifact, mirrors mileage.csv) -----------------

async function rebuildMileage(
  tx: TransactionSql,
  accountId: string,
  expenses: Expense[],
): Promise<void> {
  await tx`DELETE FROM mileage WHERE "accountId" = ${accountId}`;
  for (const e of expenses) {
    if (e.type !== "mileage") continue;
    const locationsText = e.locations
      .map((l) => l.address)
      .filter(Boolean)
      .join(" → ");
    await tx`INSERT INTO mileage ${tx({
      date: e.date,
      report: e.report,
      locations: locationsText,
      distanceMiles: e.distanceMiles,
      accountId,
    })}`;
  }
}

// --- Reports & Categories --------------------------------------------------

export async function readReports(accountId: string): Promise<Report[]> {
  await initStore();
  const rows = await db()<
    { name: string }[]
  >`SELECT "name" FROM reports WHERE "name" <> '' AND "accountId" = ${accountId} ORDER BY "id"`;
  return rows.map((r) => ({ name: r.name }));
}

export async function writeReports(
  accountId: string,
  reports: Report[],
): Promise<void> {
  await initStore();
  await db().begin(async (tx) => {
    await tx`DELETE FROM reports WHERE "accountId" = ${accountId}`;
    for (const r of reports) {
      await tx`INSERT INTO reports ${tx({ name: r.name, accountId })} ON CONFLICT ("accountId", "name") DO NOTHING`;
    }
  });
}

export async function addReport(
  accountId: string,
  name: string,
): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  await initStore();
  await db()`INSERT INTO reports ${db()({ name: clean, accountId })} ON CONFLICT ("accountId", "name") DO NOTHING`;
}

export async function removeReport(
  accountId: string,
  name: string,
): Promise<void> {
  await initStore();
  await db()`DELETE FROM reports WHERE "name" = ${name} AND "accountId" = ${accountId}`;
}

export async function renameReport(
  accountId: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const clean = newName.trim();
  if (!clean || oldName === clean) return;
  await initStore();
  await db().begin(async (tx) => {
    const clash =
      await tx`SELECT 1 FROM reports WHERE "name" = ${clean} AND "name" <> ${oldName} AND "accountId" = ${accountId}`;
    if (clash.length > 0) return;
    await tx`UPDATE reports SET "name" = ${clean} WHERE "name" = ${oldName} AND "accountId" = ${accountId}`;
    await tx`UPDATE expenses SET "report" = ${clean} WHERE "report" = ${oldName} AND "accountId" = ${accountId}`;
  });
}

export async function readCategories(accountId: string): Promise<Category[]> {
  await initStore();
  const rows = await db()<
    { name: string }[]
  >`SELECT "name" FROM categories WHERE "name" <> '' AND "accountId" = ${accountId} ORDER BY "id"`;
  return rows.map((c) => ({ name: c.name }));
}

export async function writeCategories(
  accountId: string,
  categories: Category[],
): Promise<void> {
  await initStore();
  await db().begin(async (tx) => {
    await tx`DELETE FROM categories WHERE "accountId" = ${accountId}`;
    for (const c of categories) {
      await tx`INSERT INTO categories ${tx({ name: c.name, accountId })} ON CONFLICT ("accountId", "name") DO NOTHING`;
    }
  });
}

export async function addCategory(
  accountId: string,
  name: string,
): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  await initStore();
  await db()`INSERT INTO categories ${db()({ name: clean, accountId })} ON CONFLICT ("accountId", "name") DO NOTHING`;
}

export async function removeCategory(
  accountId: string,
  name: string,
): Promise<void> {
  await initStore();
  await db()`DELETE FROM categories WHERE "name" = ${name} AND "accountId" = ${accountId}`;
}

// --- Settings --------------------------------------------------------------

export async function readSettings(accountId: string): Promise<Settings> {
  await initStore();
  const rows = await db()<
    { key: string; value: string }[]
  >`SELECT "key", "value" FROM "settings" WHERE "accountId" = ${accountId}`;
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
  await initStore();
  const rows: { accountId: string; key: string; value: string }[] = [
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
  await db().begin(async (tx) => {
    await tx`DELETE FROM "settings" WHERE "accountId" = ${accountId}`;
    for (const row of rows) {
      await tx`INSERT INTO "settings" ${tx(row)}`;
    }
  });
}

// --- Helpers ---------------------------------------------------------------

function expenseRow(e: Expense): Record<string, unknown> {
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
    locations: e.locations,
  };
}

function rowToExpense(row: ExpenseRow): Expense {
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
