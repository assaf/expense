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
 * Requires the schema to exist — run `pnpm db:push` (or prisma migrate) first.
 * All imported rows are assigned to the bootstrap account (created from
 * APP_USERNAME/APP_PASSWORD when the database is empty).
 *
 * Run with:
 *   DATABASE_URL=postgres://… BLOB_READ_WRITE_TOKEN=… node scripts/migrate-data.ts   # prod
 *   DATABASE_URL=postgres://localhost/expensify_dev IMAGE_BACKEND=pg node scripts/migrate-data.ts  # dev
 *
 * Requires Node 26+ (runs TypeScript natively). Idempotent: re-running
 * replaces the domain rows and skips images that already exist in the store.
 */
import "dotenv/config";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import { parse } from "csv-parse/sync";
import { ulid } from "ulid";
import { get, put } from "@vercel/blob";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client.ts";

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
  for (const byte of randomBytes(8)) {
    code += INVITE_CHARS[byte % INVITE_CHARS.length];
  }
  return code;
}

type ImageBackend = "blob" | "pg" | "none";

function imageBackend(): ImageBackend {
  if (IMAGE_BACKEND === "pg") return "pg";
  if (BLOB_TOKEN) return "blob";
  return "none";
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  }),
});

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
    const existing = await prisma.imageBlob.findUnique({
      where: { key: pathname },
      select: { key: true },
    });
    if (existing) return "skipped";
    await prisma.imageBlob.create({
      data: { key: pathname, mime, data: new Uint8Array(buffer) },
    });
    return "uploaded";
  }
  return "skipped";
}

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

  // --- Bootstrap account + user (all imported rows land here) ----------------
  const now = new Date().toISOString();
  const firstAccount = await prisma.account.findFirst({
    orderBy: { createdAt: "asc" },
  });
  let accountId: string;
  if (firstAccount) {
    accountId = firstAccount.id;
  } else {
    if (!APP_USERNAME || !APP_PASSWORD) {
      console.error(
        "No accounts exist and APP_USERNAME/APP_PASSWORD are not set",
      );
      process.exit(1);
    }
    const username = APP_USERNAME.trim().toLowerCase();
    accountId = ulid();
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
          id: ulid(),
          accountId,
          username,
          passwordHash: await hashPassword(APP_PASSWORD),
          name: APP_USERNAME.trim(),
          createdAt: now,
        },
      }),
    ]);
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
  await prisma.$transaction([
    prisma.expense.deleteMany(),
    prisma.expense.createMany({
      data: expenses.map((e) => ({
        id: e.id,
        type: e.type,
        date: e.date,
        report: e.report,
        category: e.category,
        description: e.description,
        amount: e.amount,
        merchant: e.merchant,
        imageFile: e.imageFile,
        imageMime: e.imageMime,
        originalName: e.originalName,
        distanceMiles: e.distanceMiles,
        locations: e.locations,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        accountId,
      })),
    }),
    prisma.report.deleteMany(),
    prisma.report.createMany({
      data: reports.map((name) => ({ name, accountId })),
      skipDuplicates: true,
    }),
    prisma.category.deleteMany(),
    prisma.category.createMany({
      data: categories.map((name) => ({ name, accountId })),
      skipDuplicates: true,
    }),
    prisma.settings.deleteMany(),
    prisma.settings.createMany({
      data: Object.entries(settingsKv).map(([key, value]) => ({
        accountId,
        key,
        value,
      })),
    }),
    prisma.mileage.deleteMany(),
    prisma.mileage.createMany({
      data: expenses
        .filter((e) => e.type === "mileage")
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

  console.info(
    `Done. ${expenses.length} expenses, ${reports.length} reports, ${categories.length} categories, ${Object.keys(settingsKv).length} settings.`,
  );
  await prisma.$disconnect();
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

main().catch(async (err) => {
  console.error("Migration failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
