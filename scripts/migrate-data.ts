#!/usr/bin/env node
/**
 * One-off migration: copy the local file-based state (CSVs under DATA_DIR and
 * receipt images under DATA_DIR/images) into Postgres + Vercel Blob.
 *
 * Run with:
 *   DATABASE_URL=postgres://… BLOB_READ_WRITE_TOKEN=… node scripts/migrate-data.ts
 *
 * Requires Node 26+ (runs TypeScript natively). The schema DDL below must stay
 * in sync with app/lib/store/pg.server.ts. Idempotent: re-running replaces the
 * DB rows and skips images that already exist in Blob.
 */
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { parse } from "csv-parse/sync";
import postgres from "postgres";
import { get, put } from "@vercel/blob";

const DATA_DIR = process.env.DATA_DIR ?? "data";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN ?? "";
const BLOB_PREFIX = "images";

// Mirrors app/lib/store/pg.server.ts
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
  if (!BLOB_TOKEN) fail("BLOB_READ_WRITE_TOKEN is required");

  console.info(
    `Migrating state from ${join(process.cwd(), DATA_DIR)} → Postgres + Vercel Blob`,
  );

  const sql = postgres(DATABASE_URL, { max: 5, connect_timeout: 10 });
  await sql.unsafe(DDL);

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

  // --- Upload receipt images to Blob ---------------------------------------
  let uploaded = 0;
  let skipped = 0;
  let missing = 0;
  const imagesDir = join(DATA_DIR, "images");
  await mkdir(imagesDir, { recursive: true });

  const receipts = expenses.filter((e) => e.type === "receipt" && e.imageFile);
  console.info(`Uploading ${receipts.length} receipt image(s) to Blob …`);
  for (const e of receipts) {
    const imageFile = e.imageFile;
    const localPath = join(imagesDir, imageFile);
    const pathname = `${BLOB_PREFIX}/${imageFile}`;
    if (!existsSync(localPath)) {
      missing++;
      console.warn(`  missing locally, keeping key as-is: ${imageFile}`);
      continue;
    }
    const existing = await get(pathname, { access: "public" });
    if (existing) {
      skipped++;
      continue;
    }
    const buffer = await readFile(localPath);
    await put(pathname, buffer, {
      access: "public",
      contentType: mimeForFile(imageFile),
      addRandomSuffix: false,
    });
    uploaded++;
    if (uploaded % 25 === 0) console.info(`  ${uploaded} uploaded …`);
  }
  console.info(
    `Images: ${uploaded} uploaded, ${skipped} already present, ${missing} missing`,
  );

  // --- Load Postgres --------------------------------------------------------
  console.info("Loading expenses, reports, categories, settings, mileage …");
  await sql.begin(async (tx) => {
    await tx`DELETE FROM expenses`;
    for (const e of expenses) {
      await tx`INSERT INTO expenses ("id", "type", "date", "report", "category", "description", "amount", "merchant", "imageFile", "imageMime", "originalName", "distanceMiles", "locations", "createdAt", "updatedAt") VALUES (${e.id}, ${e.type}, ${e.date}, ${e.report}, ${e.category}, ${e.description}, ${e.amount}, ${e.merchant}, ${e.imageFile}, ${e.imageMime}, ${e.originalName}, ${e.distanceMiles}, ${JSON.stringify(e.locations)}, ${e.createdAt}, ${e.updatedAt})`;
    }
    await tx`DELETE FROM reports`;
    for (const name of reports) {
      await tx`INSERT INTO reports ("name") VALUES (${name}) ON CONFLICT ("name") DO NOTHING`;
    }
    await tx`DELETE FROM categories`;
    for (const name of categories) {
      await tx`INSERT INTO categories ("name") VALUES (${name}) ON CONFLICT ("name") DO NOTHING`;
    }
    await tx`DELETE FROM "settings"`;
    for (const [key, value] of Object.entries(settingsKv)) {
      await tx`INSERT INTO "settings" ("key", "value") VALUES (${key}, ${value})`;
    }
    await tx`DELETE FROM mileage`;
    for (const e of expenses) {
      if (e.type !== "mileage") continue;
      const locationsText = e.locations
        .map((l) => l.address)
        .filter(Boolean)
        .join(" → ");
      await tx`INSERT INTO mileage ("date", "report", "locations", "distanceMiles") VALUES (${e.date}, ${e.report}, ${locationsText}, ${e.distanceMiles})`;
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
