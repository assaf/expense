import postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";
import { DATABASE_URL } from "~/lib/env";
import { deleteImage } from "~/lib/images.server";
import { DEFAULT_SETTINGS } from "~/lib/types";
import type {
  Category,
  Expense,
  MileageExpense,
  ReceiptExpense,
  Report,
  Settings,
} from "~/lib/types";

/**
 * Postgres-backed store. Used when DATABASE_URL is set (Vercel/Coolify
 * production). Mirrors the local CSV store's behavior and public API.
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

const DDL = `
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
  "updatedAt" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS reports (
  "id" BIGSERIAL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS categories (
  "id" BIGSERIAL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS mileage (
  "date" TEXT NOT NULL DEFAULT '',
  "report" TEXT NOT NULL DEFAULT '',
  "locations" TEXT NOT NULL DEFAULT '',
  "distanceMiles" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS "settings" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT NOT NULL DEFAULT ''
);
`;

/** Create tables on first use. Idempotent and memoized per process. */
export async function initStore(): Promise<void> {
  if (!schemaReady) {
    schemaReady = db()
      .unsafe(DDL)
      .then(() => undefined);
  }
  await schemaReady;
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

export async function readExpenses(): Promise<Expense[]> {
  await initStore();
  const rows = await db()<ExpenseRow[]>`SELECT * FROM expenses`;
  return rows.map(rowToExpense);
}

export async function readExpense(id: string): Promise<Expense | undefined> {
  await initStore();
  const rows = await db()<
    ExpenseRow[]
  >`SELECT * FROM expenses WHERE "id" = ${id}`;
  return rows.length > 0 ? rowToExpense(rows[0]) : undefined;
}

export async function writeExpenses(expenses: Expense[]): Promise<void> {
  await initStore();
  await db().begin(async (tx) => {
    await tx`DELETE FROM expenses`;
    for (const e of expenses) {
      await tx`INSERT INTO expenses ${tx(expenseRow(e))}`;
    }
    await rebuildMileage(tx, expenses);
  });
}

export async function upsertExpense(expense: Expense): Promise<void> {
  const all = await readExpenses();
  const i = all.findIndex((e) => e.id === expense.id);
  if (i >= 0) all[i] = expense;
  else all.push(expense);
  await writeExpenses(all);
}

export async function deleteExpense(id: string): Promise<void> {
  const all = await readExpenses();
  const target = all.find((e) => e.id === id);
  if (target?.type === "receipt" && target.imageFile) {
    await deleteImage(target.imageFile).catch(() => {});
  }
  await writeExpenses(all.filter((e) => e.id !== id));
}

/** Distinct merchant names previously used, most-recent first. */
export async function readPriorMerchants(): Promise<string[]> {
  await initStore();
  const rows = await db()<
    { merchant: string }[]
  >`SELECT "merchant" FROM expenses WHERE "type" = 'receipt' AND "merchant" <> '' GROUP BY "merchant" ORDER BY MAX("createdAt") DESC`;
  return rows.map((r) => r.merchant);
}

// --- Mileage table (derived artifact, mirrors mileage.csv) -----------------

async function rebuildMileage(
  tx: TransactionSql,
  expenses: Expense[],
): Promise<void> {
  await tx`DELETE FROM mileage`;
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
    })}`;
  }
}

// --- Reports & Categories --------------------------------------------------

export async function readReports(): Promise<Report[]> {
  await initStore();
  const rows = await db()<
    { name: string }[]
  >`SELECT "name" FROM reports WHERE "name" <> '' ORDER BY "id"`;
  return rows.map((r) => ({ name: r.name }));
}

export async function writeReports(reports: Report[]): Promise<void> {
  await initStore();
  await db().begin(async (tx) => {
    await tx`DELETE FROM reports`;
    for (const r of reports) {
      await tx`INSERT INTO reports ${tx({ name: r.name })} ON CONFLICT ("name") DO NOTHING`;
    }
  });
}

export async function addReport(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  await initStore();
  await db()`INSERT INTO reports ${db()({ name: clean })} ON CONFLICT ("name") DO NOTHING`;
}

export async function removeReport(name: string): Promise<void> {
  await initStore();
  await db()`DELETE FROM reports WHERE "name" = ${name}`;
}

export async function renameReport(
  oldName: string,
  newName: string,
): Promise<void> {
  const clean = newName.trim();
  if (!clean || oldName === clean) return;
  await initStore();
  await db().begin(async (tx) => {
    const clash =
      await tx`SELECT 1 FROM reports WHERE "name" = ${clean} AND "name" <> ${oldName}`;
    if (clash.length > 0) return;
    await tx`UPDATE reports SET "name" = ${clean} WHERE "name" = ${oldName}`;
    await tx`UPDATE expenses SET "report" = ${clean} WHERE "report" = ${oldName}`;
  });
}

export async function readCategories(): Promise<Category[]> {
  await initStore();
  const rows = await db()<
    { name: string }[]
  >`SELECT "name" FROM categories WHERE "name" <> '' ORDER BY "id"`;
  return rows.map((c) => ({ name: c.name }));
}

export async function writeCategories(categories: Category[]): Promise<void> {
  await initStore();
  await db().begin(async (tx) => {
    await tx`DELETE FROM categories`;
    for (const c of categories) {
      await tx`INSERT INTO categories ${tx({ name: c.name })} ON CONFLICT ("name") DO NOTHING`;
    }
  });
}

export async function addCategory(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  await initStore();
  await db()`INSERT INTO categories ${db()({ name: clean })} ON CONFLICT ("name") DO NOTHING`;
}

export async function removeCategory(name: string): Promise<void> {
  await initStore();
  await db()`DELETE FROM categories WHERE "name" = ${name}`;
}

// --- Settings --------------------------------------------------------------

export async function readSettings(): Promise<Settings> {
  await initStore();
  const rows = await db()<
    { key: string; value: string }[]
  >`SELECT "key", "value" FROM "settings"`;
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

export async function writeSettings(settings: Settings): Promise<void> {
  await initStore();
  const rows: { key: string; value: string }[] = [
    { key: "homeAddress", value: settings.homeAddress },
    {
      key: "homeLat",
      value: settings.homeLat === null ? "" : String(settings.homeLat),
    },
    {
      key: "homeLng",
      value: settings.homeLng === null ? "" : String(settings.homeLng),
    },
  ];
  for (const [year, rate] of Object.entries(settings.mileageRates)) {
    rows.push({ key: `mileageRate.${year}`, value: rate });
  }
  await db().begin(async (tx) => {
    await tx`DELETE FROM "settings"`;
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
