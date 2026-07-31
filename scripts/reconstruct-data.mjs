// One-shot reconstruction: rebuild data/expenses.csv (+ reports/mileage) from
// the Expensify export, relinking receipt images that already exist in
// data/images (the original receipts/ source folder is gone).
// Usage: node scripts/reconstruct-data.mjs /Users/assaf/Documents/Taxes/2026
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
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

/** Index of on-disk images: exact names, plus suffixed variants by base. */
async function indexImages() {
  if (!existsSync(IMG_DIR)) return { byExact: new Set(), byBase: new Map() };
  const files = (await readdir(IMG_DIR)).filter((f) => !f.startsWith("."));
  const byExact = new Set(files);
  const byBase = new Map(); // base (without ext) -> [variant files]
  for (const f of files) {
    const ext = extname(f);
    const base = basename(f, ext);
    // The import appends `-<6 chars>` to duplicate convention names.
    const m = base.match(/^(.*)-[A-Za-z0-9]{6}$/);
    const key = m ? m[1] : base;
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push(f);
  }
  return { byExact, byBase };
}

async function main() {
  const srcRows = await readCsv(join(SRC, "expensify_expenses.csv"));
  console.info(`source rows: ${srcRows.length}`);

  const existingCats = (await readCsv(join(DATA, "categories.csv"))).map(
    (r) => r.name,
  );
  const catByLower = new Map(existingCats.map((n) => [n.toLowerCase(), n]));
  const newCategories = new Set(existingCats);

  // Preserve existing reports (already cleaned of test rows).
  const existingReports = (await readCsv(join(DATA, "reports.csv"))).map(
    (r) => r.name,
  );
  const reports = new Set(existingReports);

  const { byExact, byBase } = await indexImages();
  const used = new Set();
  const expenseRows = [];

  for (const r of srcRows) {
    const report = (r.report ?? "").trim();
    if (report) reports.add(report);

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

    // Relink the receipt image already on disk (no receipts/ source anymore).
    let imageFile = "";
    let imageMime = "";
    let originalName = "";
    const receiptFile = (r.receipt_file ?? "").trim();
    if (receiptFile) {
      const ext = extname(receiptFile).toLowerCase();
      const base = basename(receiptFile, ext);
      const prefix = `${date}_${(report || "")
        .trim()
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")}_`;
      const stem = base.startsWith(prefix) ? base.slice(prefix.length) : base;
      originalName = `${stem}${ext}`;

      let destName = "";
      if (byExact.has(receiptFile) && !used.has(receiptFile)) {
        destName = receiptFile;
      } else {
        // Duplicate (or exact missing): use the next unused suffixed variant.
        const variants = (byBase.get(base) ?? []).filter((v) => !used.has(v));
        if (variants.length > 0) destName = variants[0];
      }
      if (destName) {
        used.add(destName);
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
      "",
      amount,
      merchant,
      imageFile,
      imageMime,
      originalName,
      "",
      "",
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
  await writeCsv(
    join(DATA, "mileage.csv"),
    ["date", "report", "locations", "distanceMiles"],
    [],
  );

  // Verify every imageFile actually exists on disk.
  const linked = expenseRows.filter((r) => r[8]).length;
  const broken = expenseRows.filter((r) => {
    if (!r[8]) return false;
    return !byExact.has(r[8]);
  });
  console.info(`reconstructed expenses: ${expenseRows.length}`);
  console.info(`with image linked: ${linked}`);
  console.info(`broken image links: ${broken.length}`);
  console.info(`reports: ${reports.size}, categories: ${newCategories.size}`);
  if (broken.length > 0) {
    console.warn("broken links:");
    for (const b of broken) console.warn("  ", b[8]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
