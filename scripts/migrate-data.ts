#!/usr/bin/env node
/**
 * One-off migration: copy the local file-based state (CSVs under DATA_DIR and
 * receipt images under DATA_DIR/images) into Postgres + cloud images.
 *
 * Image backend is selected like the app does:
 *   BLOB_READ_WRITE_TOKEN  → Vercel Blob (prod)
 *   S3_ENDPOINT + S3_BUCKET → S3-compatible (local MinIO dev)
 *   neither                 → images are skipped (keys kept; data still loads)
 *
 * Run with:
 *   DATABASE_URL=postgres://… BLOB_READ_WRITE_TOKEN=… node scripts/migrate-data.ts   # prod
 *   DATABASE_URL=postgres://localhost/expensify_dev S3_ENDPOINT=… S3_BUCKET=… node scripts/migrate-data.ts  # dev
 *
 * Requires Node 26+ (runs TypeScript natively). The schema DDL below must stay
 * in sync with app/lib/store/pg.server.ts. Idempotent: re-running replaces the
 * DB rows and skips images that already exist in the store.
 */
import "dotenv/config";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { parse } from "csv-parse/sync";
import postgres from "postgres";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { get, put } from "@vercel/blob";

const DATA_DIR = process.env.DATA_DIR ?? "data";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN ?? "";
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "";
const S3_BUCKET = process.env.S3_BUCKET ?? "";
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? "minioadmin";
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin";
const BLOB_PREFIX = "images";

type ImageBackend = "blob" | "s3" | "none";

function imageBackend(): ImageBackend {
  if (BLOB_TOKEN) return "blob";
  if (S3_ENDPOINT && S3_BUCKET) return "s3";
  return "none";
}

let s3Client: S3Client | undefined;

function s3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.S3_REGION ?? "us-east-1",
      endpoint: S3_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: S3_ACCESS_KEY_ID,
        secretAccessKey: S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

async function s3Exists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
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
  if (backend === "s3") {
    if (await s3Exists(pathname)) return "skipped";
    await s3().send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: pathname,
        Body: buffer,
        ContentType: mime,
      }),
    );
    return "uploaded";
  }
  return "skipped";
}

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
  const backend = imageBackend();
  const backendName =
    backend === "blob"
      ? "Vercel Blob"
      : backend === "s3"
        ? `S3 (${S3_ENDPOINT})`
        : "none (image keys kept as-is)";

  console.info(
    `Migrating state from ${join(process.cwd(), DATA_DIR)} → Postgres + ${backendName}`,
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
