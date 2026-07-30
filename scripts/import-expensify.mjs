// One-shot import: Expensify export → expensify app data files.
// Usage: node scripts/import-expensify.mjs <source-dir>
//   <source-dir> contains expensify_expenses.csv and receipts/
import { readFile, writeFile, mkdir, copyFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { ulid } from "ulid";

const SRC = process.argv[2] ?? "/Users/assaf/Documents/Taxes/2026";
const DATA = "data";
const IMG_DIR = join(DATA, "images");

const COLUMNS = [
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
];

function sanitizePart(s) {
  return s
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mimeFromExt(ext) {
  return (
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
    }[ext.toLowerCase()] ?? "image/jpeg"
  );
}

function normalizeAmount(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

async function readCsv(path) {
  try {
    const content = await readFile(path, "utf-8");
    if (content.trim() === "") return [];
    return parse(content, { relax_column_count: true, columns: true });
  } catch {
    return [];
  }
}

async function writeCsv(path, header, rows) {
  const content = stringify([header, ...rows], { quoted_string: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, path);
}

async function main() {
  await mkdir(IMG_DIR, { recursive: true });

  const srcRows = await readCsv(join(SRC, "expensify_expenses.csv"));
  console.info(`source rows: ${srcRows.length}`);

  // Build a case-insensitive category map from the user's existing categories.
  const existingCats = (await readCsv(join(DATA, "categories.csv"))).map(
    (r) => r.name,
  );
  const catByLower = new Map(existingCats.map((n) => [n.toLowerCase(), n]));
  const newCategories = new Set(existingCats);

  // Preserve existing reports; ensure all source reports exist.
  const existingReports = (await readCsv(join(DATA, "reports.csv"))).map(
    (r) => r.name,
  );
  const reports = new Set(existingReports);

  const usedDest = new Set();
  const expenseRows = [];

  for (const r of srcRows) {
    const report = (r.report ?? "").trim();
    if (report) reports.add(report);

    // Map the export category to the user's curated spelling when possible.
    const rawCat = (r.tax_category ?? r.expense_type ?? "").trim();
    let category = catByLower.get(rawCat.toLowerCase()) ?? rawCat;
    if (category && !catByLower.has(category.toLowerCase())) {
      newCategories.add(category);
      catByLower.set(category.toLowerCase(), category);
    }

    const date = (r.date ?? "").trim();
    const amount = normalizeAmount(r.amount ?? "");
    const desc = (r.description ?? "").trim();
    const merchant = desc === "(none)" || desc === "" ? "" : desc;

    // Copy the receipt image (each expense owns its own file).
    let imageFile = "";
    let imageMime = "";
    let originalName = "";
    const receiptFile = (r.receipt_file ?? "").trim();
    if (receiptFile) {
      const srcPath = join(SRC, "receipts", receiptFile);
      if (existsSync(srcPath)) {
        const ext = extname(receiptFile).toLowerCase();
        const base = basename(receiptFile, ext);
        const prefix = `${date}_${sanitizePart(report)}_`;
        const stem = base.startsWith(prefix) ? base.slice(prefix.length) : base;
        originalName = `${stem}${ext}`;
        let destName;
        if (!usedDest.has(receiptFile)) {
          destName = receiptFile;
        } else {
          destName = `${base}-${ulid().slice(-6)}${ext}`;
        }
        usedDest.add(destName);
        await copyFile(srcPath, join(IMG_DIR, destName));
        imageFile = destName;
        imageMime = mimeFromExt(ext);
      }
    }

    const now = date ? `${date}T00:00:00.000Z` : new Date().toISOString();
    expenseRows.push([
      ulid(),
      "receipt",
      date,
      report,
      category,
      "", // description (app) — merchant holds the Expensify description
      amount,
      merchant,
      imageFile,
      imageMime,
      originalName,
      "", // distanceMiles
      "", // locations
      now,
      now,
    ]);
  }

  await writeCsv(join(DATA, "expenses.csv"), COLUMNS, expenseRows);
  await writeCsv(
    join(DATA, "reports.csv"),
    ["name"],
    [...reports].map((n) => [n]),
  );
  await writeCsv(
    join(DATA, "categories.csv"),
    ["name"],
    [...newCategories].map((n) => [n]),
  );
  // No mileage-type expenses (mileage imported as receipts); keep header only.
  await writeCsv(
    join(DATA, "mileage.csv"),
    ["date", "report", "locations", "distanceMiles"],
    [],
  );

  const withImage = expenseRows.filter((r) => r[8]).length;
  console.info(`imported expenses: ${expenseRows.length}`);
  console.info(`expenses with image: ${withImage}`);
  console.info(`reports: ${reports.size}, categories: ${newCategories.size}`);
  console.info(`image files written: ${usedDest.size}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
