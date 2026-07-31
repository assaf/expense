#!/usr/bin/env node
/**
 * One-off migration: copy the local file-based state (CSVs under DATA_DIR and
 * receipt images under DATA_DIR/images) into Postgres + cloud images.
 *
 * Image backend is selected like the app does:
 *   BLOB_READ_WRITE_TOKEN  → Vercel Blob (prod)
 *   IMAGE_BACKEND=pg        → Postgres BYTEA (dev)
 *   neither                 → images are skipped (keys kept; data still loads)
 *
 * Run with:
 *   DATABASE_URL=postgres://… BLOB_READ_WRITE_TOKEN=… node scripts/migrate-data.ts   # prod
 *   DATABASE_URL=postgres://localhost/expensify_dev IMAGE_BACKEND=pg node scripts/migrate-data.ts  # dev
 *
 * Requires Node 26+ (runs TypeScript natively). The schema DDL below must stay
 * in sync with app/lib/store/database.ts. Idempotent: re-running replaces the
 * DB rows and skips images that already exist in the store.
 */
import "dotenv/config";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import { parse } from "csv-parse/sync";
import postgres from "postgres";
import { ulid } from "ulid";
import { get, put } from "@vercel/blob";

const DATA_DIR = process.env.DATA_DIR ?? "data";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN ?? "";
const IMAGE_BACKEND = process.env.IMAGE_BACKEND ?? "";
const APP_USERNAME = process.env.APP_USERNAME ?? "";
const APP_PASSWORD = process.env.APP_PASSWORD ?? "";
const BLOB_PREFIX = "images";

// Mirrored from app/lib/passwords.ts (keeps this script self-contained).
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

const INVITE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateInviteCode(): string {
  let code = "";
  for (const byte of randomBytes(8))
    code += INVITE_CHARS[byte % INVITE_CHARS.length];
  return code;
}

type ImageBackend = "blob" | "pg" | "none";

function imageBackend(): ImageBackend {
  if (IMAGE_BACKEND === "pg") return "pg";
  if (BLOB_TOKEN) return "blob";
  return "none";
}

let migrateSql: postgres.Sql | undefined;

function db(): postgres.Sql {
  if (!migrateSql) {
    if (!DATABASE_URL) fail("DATABASE_URL is required");
    migrateSql = postgres(DATABASE_URL, { max: 5, connect_timeout: 10 });
  }
  return migrateSql;
}

/** Upload one image to the active backend; returns "uploaded" | "skipped". */
async function uploadImage(
  pathname: string,
  buffer: Buffer,
  mime: string,
): Promise<"uploaded" | "skipped"> {
  const backend = imageBackend();
  if (backend === "blob") {
    const existing = await get(pathname, { access: "public" });
    if (existing) return "skipped";
    await put(pathname, buffer, {
      access: "public",
      contentType: mime,
      addRandomSuffix: false,
    });
    return "uploaded";
  }
  if (backend === "pg") {
    const rows =
      await db()`SELECT 1 FROM image_blobs WHERE "key" = ${pathname} LIMIT 1`;
    if (rows.length > 0) return "skipped";
    await db()`INSERT INTO image_blobs ("key", "mime", "data") VALUES (${pathname}, ${mime}, ${buffer})`;
    return "uploaded";
  }
  return "skipped";
}

// Mirrors app/lib/database.ts
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

interface ExpenseRecord {
  id: string;
  type: "receipt" | "mileage";
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
  locations: Array<{
    address: string;
    lat: number | null;
    lng: number | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function readCsv(file: string): Promise<string[][]> {
  const path = join(DATA_DIR, file);
  if (!existsSync(path)) return [];
  const content = await readFile(path, "utf-8");
  if (content.trim() === "") return [];
  return parse(content, { relax_column_count: true });
}

function columnIndex(header: string[]): (name: string) => number {
  return (name: string) => {
    const i = header.indexOf(name);
    return i === -1 ? 0 : i;
  };
}

function safeParseLocations(raw: string): Array<{
  address: string;
  lat: number | null;
  lng: number | null;
}> {
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

function mimeForFile(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".heic": "image/heic",
  };
  return map[ext] ?? "image/jpeg";
}

async function main(): Promise<void> {
  if (!DATABASE_URL) fail("DATABASE_URL is required");
  const backend = imageBackend();
  const backendName =
    backend === "blob"
      ? "Vercel Blob"
      : backend === "pg"
        ? "Postgres (BYTEA)"
        : "none (image keys kept as-is)";

  console.info(
    `Migrating state from ${join(process.cwd(), DATA_DIR)} → Postgres + ${backendName}`,
  );

  const sql = db();
  await sql.unsafe(DDL);

  // --- Bootstrap account + user (all imported rows land here) ----------------
  const now = new Date().toISOString();
  const accounts =
    await sql`SELECT "id" FROM accounts ORDER BY "createdAt" LIMIT 1`;
  let accountId: string;
  if (accounts.length > 0) {
    accountId = accounts[0].id as string;
  } else {
    if (!APP_USERNAME || !APP_PASSWORD) {
      fail("No accounts exist and APP_USERNAME/APP_PASSWORD are not set");
    }
    const username = APP_USERNAME.trim().toLowerCase();
    accountId = ulid();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO accounts ("id", "name", "inviteCode", "createdAt") VALUES (${accountId}, ${APP_USERNAME.trim()}, ${generateInviteCode()}, ${now})`;
      await tx`INSERT INTO users ("id", "accountId", "username", "passwordHash", "name", "createdAt") VALUES (${ulid()}, ${accountId}, ${username}, ${await hashPassword(APP_PASSWORD)}, ${APP_USERNAME.trim()}, ${now})`;
    });
    console.info(`Created bootstrap account + user "${username}"`);
  }

  // --- Parse CSVs -----------------------------------------------------------
  const expenseRows = await readCsv("expenses.csv");
  const reportRows = await readCsv("reports.csv");
  const categoryRows = await readCsv("categories.csv");
  const settingsRows = await readCsv("settings.csv");

  const reports = parseNames(reportRows);
  const categories = parseNames(categoryRows);
  const settingsKv = parseKv(settingsRows);

  const expenses: ExpenseRecord[] = [];
  const [header, ...body] = expenseRows;
  if (header) {
    const idx = columnIndex(header);
    for (const row of body) {
      if (!row || row.every((c) => c === "")) continue;
      const type = row[idx("type")] as "receipt" | "mileage";
      const locations =
        type === "mileage"
          ? safeParseLocations(row[idx("locations")] ?? "[]")
          : [];
      expenses.push({
        id: row[idx("id")] ?? "",
        type,
        date: row[idx("date")] ?? "",
        report: row[idx("report")] ?? "",
        category: row[idx("category")] ?? "",
        description: row[idx("description")] ?? "",
        amount: row[idx("amount")] ?? "",
        merchant: row[idx("merchant")] ?? "",
        imageFile: row[idx("imageFile")] ?? "",
        imageMime: row[idx("imageMime")] ?? "",
        originalName: row[idx("originalName")] ?? "",
        distanceMiles: row[idx("distanceMiles")] ?? "",
        locations,
        createdAt: row[idx("createdAt")] ?? "",
        updatedAt: row[idx("updatedAt")] ?? "",
      });
    }
  }

  // --- Upload receipt images to the active store --------------------------
  let uploaded = 0;
  let skipped = 0;
  let missing = 0;
  const imagesDir = join(DATA_DIR, "images");
  await mkdir(imagesDir, { recursive: true });

  const receipts = expenses.filter((e) => e.type === "receipt" && e.imageFile);
  if (backend === "none") {
    console.info(
      `${receipts.length} receipt image(s) referenced; no image backend configured — skipping uploads.`,
    );
  } else {
    console.info(`Uploading ${receipts.length} receipt image(s) …`);
  }
  for (const e of receipts) {
    const imageFile = e.imageFile;
    const localPath = join(imagesDir, imageFile);
    const pathname = `${BLOB_PREFIX}/${imageFile}`;
    if (!existsSync(localPath)) {
      missing++;
      console.warn(`  missing locally, keeping key as-is: ${imageFile}`);
      continue;
    }
    if (backend === "none") continue;
    const buffer = await readFile(localPath);
    const result = await uploadImage(pathname, buffer, mimeForFile(imageFile));
    if (result === "uploaded") {
      uploaded++;
      if (uploaded % 25 === 0) console.info(`  ${uploaded} uploaded …`);
    } else {
      skipped++;
    }
  }
  console.info(
    `Images: ${uploaded} uploaded, ${skipped} already present, ${missing} missing`,
  );

  // --- Load Postgres --------------------------------------------------------
  console.info(
    `Loading expenses, reports, categories, settings, mileage (account ${accountId}) …`,
  );
  await sql.begin(async (tx) => {
    await tx`DELETE FROM expenses`;
    for (const e of expenses) {
      await tx`INSERT INTO expenses ("id", "type", "date", "report", "category", "description", "amount", "merchant", "imageFile", "imageMime", "originalName", "distanceMiles", "locations", "createdAt", "updatedAt", "accountId") VALUES (${e.id}, ${e.type}, ${e.date}, ${e.report}, ${e.category}, ${e.description}, ${e.amount}, ${e.merchant}, ${e.imageFile}, ${e.imageMime}, ${e.originalName}, ${e.distanceMiles}, ${JSON.stringify(e.locations)}, ${e.createdAt}, ${e.updatedAt}, ${accountId})`;
    }
    await tx`DELETE FROM reports`;
    for (const name of reports) {
      await tx`INSERT INTO reports ("name", "accountId") VALUES (${name}, ${accountId}) ON CONFLICT ("accountId", "name") DO NOTHING`;
    }
    await tx`DELETE FROM categories`;
    for (const name of categories) {
      await tx`INSERT INTO categories ("name", "accountId") VALUES (${name}, ${accountId}) ON CONFLICT ("accountId", "name") DO NOTHING`;
    }
    await tx`DELETE FROM "settings"`;
    for (const [key, value] of Object.entries(settingsKv)) {
      await tx`INSERT INTO "settings" ("accountId", "key", "value") VALUES (${accountId}, ${key}, ${value})`;
    }
    await tx`DELETE FROM mileage`;
    for (const e of expenses) {
      if (e.type !== "mileage") continue;
      const locationsText = e.locations
        .map((l) => l.address)
        .filter(Boolean)
        .join(" → ");
      await tx`INSERT INTO mileage ("date", "report", "locations", "distanceMiles", "accountId") VALUES (${e.date}, ${e.report}, ${locationsText}, ${e.distanceMiles}, ${accountId})`;
    }
  });

  console.info(
    `Done. ${expenses.length} expenses, ${reports.length} reports, ${categories.length} categories, ${Object.keys(settingsKv).length} settings.`,
  );
  await sql.end();
}

function parseNames(rows: string[][]): string[] {
  const [header, ...body] = rows;
  if (!header) return [];
  const i = header.indexOf("name");
  const names = body
    .map((r) => r[i] ?? "")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

function parseKv(rows: string[][]): Record<string, string> {
  const [header, ...body] = rows;
  if (!header) return {};
  const ki = header.indexOf("key");
  const vi = header.indexOf("value");
  const kv: Record<string, string> = {};
  for (const row of body) {
    const key = row[ki] ?? "";
    const value = row[vi] ?? "";
    if (key) kv[key] = value;
  }
  return kv;
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
