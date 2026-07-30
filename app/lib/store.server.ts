import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { ulid } from "ulid";
import { DATA_DIR } from "~/lib/env";
import {
  type Category,
  type Expense,
  type MileageExpense,
  type ReceiptExpense,
  type Report,
  type Settings,
  DEFAULT_SETTINGS,
} from "~/lib/types";

const IMAGES_DIR = join(DATA_DIR, "images");
const EXPENSES_CSV = join(DATA_DIR, "expenses.csv");
const REPORTS_CSV = join(DATA_DIR, "reports.csv");
const CATEGORIES_CSV = join(DATA_DIR, "categories.csv");
const MILEAGE_CSV = join(DATA_DIR, "mileage.csv");
const SETTINGS_CSV = join(DATA_DIR, "settings.csv");

const EXPENSE_COLUMNS = [
  "id",
  "type",
  "date",
  "report",
  "category",
  "description",
  "amount",
  "merchant",
  "imageFile",
  "imageMime",
  "originalName",
  "distanceMiles",
  "locations",
  "createdAt",
  "updatedAt",
] as const;

const DEFAULT_REPORTS = ["2026 Business"];
const DEFAULT_CATEGORIES = [
  "Advertising",
  "Meals",
  "Office Supplies",
  "Travel",
  "Utilities",
];

let initialized = false;

/** Create the data directory and seed empty CSV files on first use. */
export async function initStore(): Promise<void> {
  if (initialized) return;
  await mkdir(IMAGES_DIR, { recursive: true });

  if (!(await pathExists(EXPENSES_CSV))) {
    await writeCsv(EXPENSES_CSV, [[...EXPENSE_COLUMNS]]);
  }
  if (!(await pathExists(REPORTS_CSV))) {
    await writeCsv(REPORTS_CSV, [["name"], ...DEFAULT_REPORTS.map((n) => [n])]);
  }
  if (!(await pathExists(CATEGORIES_CSV))) {
    await writeCsv(CATEGORIES_CSV, [
      ["name"],
      ...DEFAULT_CATEGORIES.map((n) => [n]),
    ]);
  }
  if (!(await pathExists(MILEAGE_CSV))) {
    await writeCsv(MILEAGE_CSV, [["date", "report", "locations"]]);
  }
  if (!(await pathExists(SETTINGS_CSV))) {
    await writeCsv(SETTINGS_CSV, [
      ["key", "value"],
      ["homeAddress", ""],
      ["homeLat", ""],
      ["homeLng", ""],
    ]);
  }
  initialized = true;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

async function readCsvRaw(path: string): Promise<string[][]> {
  try {
    const content = await readFile(path, "utf-8");
    if (content.trim() === "") return [];
    return parse(content, { relax_column_count: true });
  } catch {
    return [];
  }
}

async function writeCsv(path: string, rows: string[][]): Promise<void> {
  const content = stringify(rows, { quoted_string: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, path);
}

// --- Expenses --------------------------------------------------------------

export async function readExpenses(): Promise<Expense[]> {
  await initStore();
  const rows = await readCsvRaw(EXPENSES_CSV);
  const [header, ...body] = rows;
  if (!header) return [];
  const idx = columnIndex(header);
  const expenses: Expense[] = [];
  for (const row of body) {
    if (!row || row.every((c) => c === "")) continue;
    const type = row[idx("type")] as Expense["type"];
    const base = {
      id: row[idx("id")] || ulid(),
      type,
      date: row[idx("date")] ?? "",
      report: row[idx("report")] ?? "",
      category: row[idx("category")] ?? "",
      description: row[idx("description")] ?? "",
      amount: row[idx("amount")] ?? "",
      createdAt: row[idx("createdAt")] ?? "",
      updatedAt: row[idx("updatedAt")] ?? "",
    };
    if (type === "receipt") {
      const receipt: ReceiptExpense = {
        ...base,
        type: "receipt",
        merchant: row[idx("merchant")] ?? "",
        imageFile: row[idx("imageFile")] ?? "",
        imageMime: row[idx("imageMime")] ?? "",
        originalName: row[idx("originalName")] ?? "",
      };
      expenses.push(receipt);
    } else {
      const locations = safeParseLocations(row[idx("locations")] ?? "[]");
      const mileage: MileageExpense = {
        ...base,
        type: "mileage",
        locations,
        distanceMiles: row[idx("distanceMiles")] ?? "",
      };
      expenses.push(mileage);
    }
  }
  return expenses;
}

export async function readExpense(id: string): Promise<Expense | undefined> {
  const all = await readExpenses();
  return all.find((e) => e.id === id);
}

export async function writeExpenses(expenses: Expense[]): Promise<void> {
  await initStore();
  const rows: string[][] = [[...EXPENSE_COLUMNS]];
  for (const e of expenses) {
    const common = [
      e.id,
      e.type,
      e.date,
      e.report,
      e.category,
      e.description,
      e.amount,
      e.createdAt,
      e.updatedAt,
    ];
    if (e.type === "receipt") {
      rows.push([
        ...common.slice(0, 7),
        e.merchant,
        e.imageFile,
        e.imageMime,
        e.originalName,
        "", // distanceMiles
        "", // locations
        ...common.slice(7),
      ]);
    } else {
      rows.push([
        ...common.slice(0, 7),
        "", // merchant
        "", // imageFile
        "", // imageMime
        "", // originalName
        e.distanceMiles,
        JSON.stringify(e.locations),
        ...common.slice(7),
      ]);
    }
  }
  await writeCsv(EXPENSES_CSV, rows);
  await rebuildMileageCsv(expenses);
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
    await deleteImageFile(target.imageFile).catch(() => {});
  }
  await writeExpenses(all.filter((e) => e.id !== id));
}

/** Distinct merchant names previously used, most-recent first. */
export async function readPriorMerchants(): Promise<string[]> {
  const all = await readExpenses();
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const e of all) {
    if (e.type === "receipt" && e.merchant && !seen.has(e.merchant)) {
      seen.add(e.merchant);
      ordered.push(e.merchant);
    }
  }
  return ordered;
}

function safeParseLocations(raw: string): MileageExpense["locations"] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (v): v is { address: string; lat: number | null; lng: number | null } =>
          v && typeof v === "object" && "address" in v,
      )
      .map((v) => ({
        address: typeof v.address === "string" ? v.address : "",
        lat: typeof v.lat === "number" ? v.lat : null,
        lng: typeof v.lng === "number" ? v.lng : null,
      }));
  } catch {
    return [];
  }
}

// --- Mileage CSV (derived artifact) ----------------------------------------

async function rebuildMileageCsv(expenses: Expense[]): Promise<void> {
  const rows: string[][] = [["date", "report", "locations", "distanceMiles"]];
  for (const e of expenses) {
    if (e.type !== "mileage") continue;
    const locationsText = e.locations
      .map((l) => l.address)
      .filter(Boolean)
      .join(" → ");
    rows.push([e.date, e.report, locationsText, e.distanceMiles]);
  }
  await writeCsv(MILEAGE_CSV, rows);
}

// --- Reports & Categories --------------------------------------------------

export async function readReports(): Promise<Report[]> {
  await initStore();
  const rows = await readCsvRaw(REPORTS_CSV);
  const [header, ...body] = rows;
  if (!header) return [];
  const i = header.indexOf("name");
  const names = body
    .map((r) => r[i] ?? "")
    .map((s) => s.trim())
    .filter(Boolean);
  return dedupe(names).map((name) => ({ name }));
}

export async function writeReports(reports: Report[]): Promise<void> {
  await initStore();
  await writeCsv(REPORTS_CSV, [["name"], ...reports.map((r) => [r.name])]);
}

export async function addReport(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  const reports = await readReports();
  if (reports.some((r) => r.name === clean)) return;
  reports.push({ name: clean });
  await writeReports(reports);
}

export async function removeReport(name: string): Promise<void> {
  const reports = (await readReports()).filter((r) => r.name !== name);
  await writeReports(reports);
}

export async function renameReport(
  oldName: string,
  newName: string,
): Promise<void> {
  const clean = newName.trim();
  if (!clean || oldName === clean) return;
  const reports = (await readReports()).map((r) =>
    r.name === oldName ? { name: clean } : r,
  );
  await writeReports(reports);
  // Propagate to expenses and image filenames.
  const expenses = await readExpenses();
  let changed = false;
  for (const e of expenses) {
    if (e.report === oldName) {
      e.report = clean;
      changed = true;
    }
  }
  if (changed) await writeExpenses(expenses);
}

export async function readCategories(): Promise<Category[]> {
  await initStore();
  const rows = await readCsvRaw(CATEGORIES_CSV);
  const [header, ...body] = rows;
  if (!header) return [];
  const i = header.indexOf("name");
  const names = body
    .map((r) => r[i] ?? "")
    .map((s) => s.trim())
    .filter(Boolean);
  return dedupe(names).map((name) => ({ name }));
}

export async function writeCategories(categories: Category[]): Promise<void> {
  await initStore();
  await writeCsv(CATEGORIES_CSV, [
    ["name"],
    ...categories.map((c) => [c.name]),
  ]);
}

export async function addCategory(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  const categories = await readCategories();
  if (categories.some((c) => c.name === clean)) return;
  categories.push({ name: clean });
  await writeCategories(categories);
}

export async function removeCategory(name: string): Promise<void> {
  const categories = (await readCategories()).filter((c) => c.name !== name);
  await writeCategories(categories);
}

// --- Settings --------------------------------------------------------------

export async function readSettings(): Promise<Settings> {
  await initStore();
  const rows = await readCsvRaw(SETTINGS_CSV);
  const [header, ...body] = rows;
  const settings: Settings = { ...DEFAULT_SETTINGS, mileageRates: {} };
  if (!header) return settings;
  const ki = header.indexOf("key");
  const vi = header.indexOf("value");
  const kv: Record<string, string> = {};
  for (const row of body) {
    const key = row[ki] ?? "";
    const value = row[vi] ?? "";
    if (key) kv[key] = value;
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
  const rows: string[][] = [
    ["key", "value"],
    ["homeAddress", settings.homeAddress],
    ["homeLat", settings.homeLat === null ? "" : String(settings.homeLat)],
    ["homeLng", settings.homeLng === null ? "" : String(settings.homeLng)],
  ];
  for (const [year, rate] of Object.entries(settings.mileageRates)) {
    rows.push([`mileageRate.${year}`, rate]);
  }
  await writeCsv(SETTINGS_CSV, rows);
}

// --- Image file helpers ----------------------------------------------------

export function imagesDir(): string {
  return IMAGES_DIR;
}

export async function deleteImageFile(filename: string): Promise<void> {
  if (!filename) return;
  const full = join(IMAGES_DIR, filename);
  if (existsSync(full)) await unlink(full);
}

// --- Utilities -------------------------------------------------------------

function columnIndex(header: string[]): (name: string) => number {
  return (name: string) => {
    const i = header.indexOf(name);
    return i === -1 ? 0 : i;
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Build a new expense shell with sensible defaults. */
export function newExpenseShell(type: Expense["type"]): Expense {
  const now = new Date().toISOString();
  const base = {
    id: ulid(),
    date: "",
    report: "",
    category: "",
    description: "",
    amount: "",
    createdAt: now,
    updatedAt: now,
  };
  if (type === "receipt") {
    const receipt: ReceiptExpense = {
      ...base,
      type: "receipt",
      merchant: "",
      imageFile: "",
      imageMime: "",
      originalName: "",
    };
    return receipt;
  }
  const mileage: MileageExpense = {
    ...base,
    type: "mileage",
    locations: [],
    distanceMiles: "",
  };
  return mileage;
}
