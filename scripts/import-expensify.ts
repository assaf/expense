#!/usr/bin/env node
/**
 * Import expenses from the Expensify Integration Server API into the app.
 *
 * Why this replaces the old CSV-export import:
 *  - The old export carried the ORIGINAL merchant/amount (empty for
 *    SmartScan'd receipts) instead of the EFFECTIVE values, so ~253 expenses
 *    landed in the app with no merchant and $0.00.
 *  - It referenced receipts by collision-prone convention filenames
 *    (`{date}_{report}_no_desc.jpg`), so same-date-same-report expenses all
 *    got the same (wrong) receipt file and some receipts never made it at
 *    all (e.g. the Hoxton lunch receipt on 2026-07-23).
 *  - The old export's "date" column was actually the effective expense date
 *    (modifiedCreated), not the transaction's creation timestamp.
 *
 * This importer:
 *   1. Exports all transactions via the Integration Server API with a
 *      template that captures the EFFECTIVE fields: modifiedMerchant,
 *      modifiedAmount (cents), modifiedCreated, comment, and the real
 *      receipt URL (receiptObject.url).
 *   2. Downloads each receipt and stores a browser-displayable image
 *      (PDFs are rasterized to PNG) in Postgres (image_blobs).
 *   3. Rebuilds the expenses table for the account from the live data.
 *
 * Receipt downloads are login-gated by Expensify; pass an authenticated
 * session cookie via --cookie <value> or EXPENSIFY_COOKIE. Without one the
 * import still fixes all metadata and leaves imageFile empty for later.
 *
 * Usage:
 *   DATABASE_URL=… \
 *     EXPENSIFY_PARTNER_USER_ID=… EXPENSIFY_PARTNER_USER_SECRET=… \
 *     node scripts/import-expensify.ts [--cookie '…'] [--dry-run]
 */
import "dotenv/config";
import { parse } from "csv-parse/sync";
import { ulid } from "ulid";
import sharp from "sharp";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client.ts";

const ENDPOINT =
  "https://integrations.expensify.com/Integration-Server/ExpensifyIntegrations";

const PARTNER_USER_ID =
  process.env.EXPENSIFY_PARTNER_USER_ID ?? "aa_assaf_labnotes_org";
const PARTNER_USER_SECRET = process.env.EXPENSIFY_PARTNER_USER_SECRET ?? "";
const COOKIE = process.env.EXPENSIFY_COOKIE ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DRY_RUN = process.argv.includes("--dry-run");
const START_YEAR = process.env.EXPENSIFY_START_YEAR ?? "2026";

// The cookie flag can arrive anywhere in argv.
for (const arg of process.argv) {
  if (arg.startsWith("--cookie=")) {
    process.env.EXPENSIFY_COOKIE = arg.slice("--cookie=".length);
  }
}

// Optional local dir with receipt files keyed by their stored filename
// (e.g. exported via the browser session when the API download is gated).
const RECEIPTS_DIR =
  process.env.EXPENSIFY_RECEIPTS_DIR ??
  process.argv
    .find((a) => a.startsWith("--receipts-dir="))
    ?.slice("--receipts-dir=".length) ??
  "";

if (!PARTNER_USER_SECRET) {
  console.error("EXPENSIFY_PARTNER_USER_SECRET is required");
  process.exit(1);
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

/**
 * Export template. Field notes (verified against the live API):
 *  - transaction.modifiedMerchant / modifiedAmount are the EFFECTIVE
 *    (SmartScan'd / user-edited) values; transaction.merchant / amount are
 *    the original (often "(none)" / 0).
 *  - modifiedCreated is the expense date the user set (the old export's
 *    "date" column); created is the entry timestamp.
 *  - receiptObject.url is the real receipt file (login-gated); thumbnails
 *    are gated too.
 */
const TEMPLATE =
  "<#if addHeader == true>transactionID,reportID,reportName,expenseDate," +
  "merchant,effectiveMerchant,amountCents,effectiveAmountCents,currency," +
  "category,comment,tag,reimbursable,billable,receiptID,receiptFilename," +
  "receiptURL,receiptType,receiptState<#lt></#if>\n" +
  "<#list reports as report>\n" +
  "<#list report.transactionList as transaction>\n" +
  '${transaction.transactionID!""},${report.reportID!""},${report.reportName!""},' +
  "<#if transaction.modifiedCreated?has_content>${transaction.modifiedCreated}" +
  '<#else>${transaction.created!""}</#if>,' +
  '${transaction.merchant!""},${transaction.modifiedMerchant!""},' +
  '${transaction.amount!""},${transaction.modifiedAmount!""},' +
  '${transaction.currency!""},${transaction.category!""},${transaction.comment!""},' +
  '${transaction.tag!""},${transaction.reimbursable!""},${transaction.billable!""},' +
  '${transaction.receiptID!""},${transaction.receiptFilename!""},' +
  '<#if transaction.receiptObject??>${transaction.receiptObject.url!""}<#else></#if>,' +
  '<#if transaction.receiptObject??>${transaction.receiptObject.type!""}<#else></#if>,' +
  '${transaction.receiptState!""}<#lt>\n' +
  "</#list>\n" +
  "</#list>";

async function expensifyPost(form: Record<string, string>): Promise<string> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) body.append(k, v);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return res.text();
}

interface LiveTransaction {
  transactionID: string;
  reportID: string;
  reportName: string;
  date: string;
  merchant: string;
  amount: string; // dollars, "0.00"
  currency: string;
  category: string;
  comment: string;
  tag: string;
  reimbursable: boolean;
  billable: boolean;
  receiptID: string;
  receiptFilename: string;
  receiptURL: string;
  receiptType: string;
}

function parseBool(v: string): boolean {
  return v === "true" || v === "1" || v === "Y" || v === "y";
}

/** Export all transactions for the year range and return parsed records. */
async function exportTransactions(): Promise<LiveTransaction[]> {
  const fileRes = await expensifyPost({
    requestJobDescription: JSON.stringify({
      type: "file",
      credentials: {
        partnerUserID: PARTNER_USER_ID,
        partnerUserSecret: PARTNER_USER_SECRET,
      },
      onReceive: { immediateResponse: ["returnRandomFileName"] },
      inputSettings: {
        type: "combinedReportData",
        filters: {
          startDate: `${START_YEAR}-01-01`,
          endDate: `${START_YEAR}-12-31`,
        },
      },
      outputSettings: { fileExtension: "csv" },
    }),
    template: TEMPLATE,
  });
  const fileName = fileRes.trim();
  if (!fileName || fileName.includes('"')) {
    throw new Error(`Export job failed: ${fileRes.slice(0, 300)}`);
  }
  const csv = await expensifyPost({
    requestJobDescription: JSON.stringify({
      type: "download",
      credentials: {
        partnerUserID: PARTNER_USER_ID,
        partnerUserSecret: PARTNER_USER_SECRET,
      },
      fileName,
      fileSystem: "integrationServer",
    }),
  });
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];
  const out: LiveTransaction[] = [];
  for (const r of rows) {
    const effMerchant =
      (r.effectiveMerchant ?? "").trim() || (r.merchant ?? "").trim();
    // Modified amount (SmartScan/user edit) wins; fall back to the original
    // amount when it is empty — but treat "0" as a real value, not empty.
    const effCents =
      (r.effectiveAmountCents ?? "").trim() || (r.amountCents ?? "").trim();
    const cents = effCents ? Number(effCents) : 0;
    out.push({
      transactionID: (r.transactionID ?? "").trim(),
      reportID: (r.reportID ?? "").trim(),
      reportName: (r.reportName ?? "").trim(),
      date: (r.expenseDate ?? "").trim().split(" ")[0] ?? "",
      merchant: effMerchant === "(none)" ? "" : effMerchant,
      amount: Number.isFinite(cents) ? (cents / 100).toFixed(2) : "0.00",
      currency: (r.currency ?? "USD").trim(),
      category: (r.category ?? "").trim(),
      comment: (r.comment ?? "").trim(),
      tag: (r.tag ?? "").trim(),
      reimbursable: parseBool((r.reimbursable ?? "").trim()),
      billable: parseBool((r.billable ?? "").trim()),
      receiptID: (r.receiptID ?? "").trim(),
      receiptFilename: (r.receiptFilename ?? "").trim(),
      receiptURL: (r.receiptURL ?? "").trim(),
      receiptType: (r.receiptType ?? "").trim(),
    });
  }
  console.info(`Exported ${out.length} transactions (${fileName})`);
  return out;
}

// --- Receipt download + storage ----------------------------------------------

const PDFJS_PARAMS = {
  disableFontFace: true,
  standardFontDataUrl:
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/standard_fonts/",
  useWorkerFetch: false,
  verbosity: 0,
} as const;

/** Rasterize a PDF receipt to a stacked PNG (mirrors renderPdfToPng). */
async function pdfToPng(buffer: Buffer): Promise<Buffer> {
  const task = getDocument({
    data: new Uint8Array(buffer),
    ...PDFJS_PARAMS,
  });
  const doc = await task.promise;
  try {
    const pages = Math.min(doc.numPages, 3);
    const canvases: { width: number; height: number; buffer: Buffer }[] = [];
    let width = 0;
    let height = 0;
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, viewport.width, viewport.height);
      await page.render({
        canvasContext: ctx,
        viewport,
      } as unknown as Parameters<typeof page.render>[0]).promise;
      canvases.push({
        width: viewport.width,
        height: viewport.height,
        buffer: canvas.toBuffer("image/png"),
      });
      width = Math.max(width, viewport.width);
      height += viewport.height;
    }
    if (canvases.length === 1) return canvases[0]!.buffer;
    const stacked = createCanvas(width, height);
    const ctx = stacked.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    let y = 0;
    for (const c of canvases) {
      const img = createCanvas(c.width, c.height);
      const ictx = img.getContext("2d");
      ictx.drawImage(
        // @napi-rs/canvas canvases draw directly into one another.
        await loadCanvasFromPng(c.buffer),
        0,
        0,
      );
      ctx.drawImage(img, 0, y);
      y += c.height;
    }
    return stacked.toBuffer("image/png");
  } finally {
    await task.destroy();
  }
}

/** Decode a PNG buffer back into a @napi-rs/canvas Image (for stacking). */
async function loadCanvasFromPng(buffer: Buffer): Promise<Image> {
  return loadImage(buffer);
}

/** Download a receipt and return a browser-displayable image buffer+mime. */
async function downloadReceipt(
  url: string,
  type: string,
  filename: string,
): Promise<{ buffer: Buffer; mime: string } | null> {
  let buf: Buffer | null = null;
  if (RECEIPTS_DIR) {
    // Local files from a browser-driven export: keyed by stored filename.
    const { readFileSync, existsSync } = await import("node:fs");
    const local = RECEIPTS_DIR.endsWith("/")
      ? RECEIPTS_DIR
      : `${RECEIPTS_DIR}/`;
    const bare = url.split("/").pop() ?? "";
    const found = existsSync(`${local}${filename}`)
      ? `${local}${filename}`
      : existsSync(`${local}${bare}`)
        ? `${local}${bare}`
        : null;
    if (!found) {
      console.warn(`  receipt file missing locally: ${filename}`);
      return null;
    }
    buf = readFileSync(found);
  } else {
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
    };
    if (COOKIE) headers["Cookie"] = COOKIE;
    const res = await fetch(url, { headers });
    buf = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || buf.length < 100) {
      console.warn(`  receipt download failed (${res.status}): ${url}`);
      return null;
    }
  }
  if (type === "pdf" || url.toLowerCase().endsWith(".pdf")) {
    try {
      return { buffer: await pdfToPng(buf), mime: "image/png" };
    } catch (err) {
      console.warn(
        `  pdf render failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
  // Image receipts: normalize like the app does (flatten alpha, cap width).
  const meta = await sharp(buf)
    .metadata()
    .catch(() => null);
  if (meta?.width) {
    const img =
      meta.width > 4000
        ? sharp(buf).resize({ width: 4000, withoutEnlargement: true })
        : sharp(buf);
    const out = await img.flatten({ background: "#ffffff" }).toBuffer();
    return { buffer: out, mime: "image/jpeg" };
  }
  return { buffer: buf, mime: "image/jpeg" };
}

function mimeToExt(mime: string): string {
  return mime === "image/png" ? ".png" : ".jpg";
}

// --- DB reconciliation --------------------------------------------------------

async function reconcile(
  transactions: LiveTransaction[],
): Promise<{ receiptsStored: number; receiptsSkipped: number }> {
  const account = await prisma.account.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (!account) throw new Error("No account found in the database");
  const accountId = account.id;

  // Upsert reports + categories from the live data (case-insensitive match
  // against existing rows; add new ones with the live spelling).
  const existingReports = new Map(
    (await prisma.report.findMany({ where: { accountId } })).map((r) => [
      r.name.toLowerCase(),
      r,
    ]),
  );
  const existingCategories = new Map(
    (await prisma.category.findMany({ where: { accountId } })).map((c) => [
      c.name.toLowerCase(),
      c,
    ]),
  );
  const reportNames = new Set<string>();
  const categoryNames = new Set<string>();
  for (const t of transactions) {
    if (t.reportName) reportNames.add(t.reportName);
    if (t.category) categoryNames.add(t.category);
  }
  const reportAdds = [...reportNames].filter(
    (n) => !existingReports.has(n.toLowerCase()),
  );
  const categoryAdds = [...categoryNames].filter(
    (n) => !existingCategories.has(n.toLowerCase()),
  );
  if (reportAdds.length) {
    await prisma.report.createMany({
      data: reportAdds.map((name) => ({ name, accountId })),
      skipDuplicates: true,
    });
    console.info(`Added reports: ${reportAdds.join(", ")}`);
  }
  if (categoryAdds.length) {
    await prisma.category.createMany({
      data: categoryAdds.map((name) => ({ name, accountId })),
      skipDuplicates: true,
    });
    console.info(`Added categories: ${categoryAdds.join(", ")}`);
  }
  // Map live spellings to the account's existing category/report names
  // (case-insensitive) so expenses keep the spelling the app already uses.
  const categorySpelling = new Map(
    [...existingCategories.values()].map((c) => [c.name.toLowerCase(), c.name]),
  );
  const reportSpelling = new Map(
    [...existingReports.values()].map((r) => [r.name.toLowerCase(), r.name]),
  );

  // Download receipts first (outside the transaction so partial failures
  // don't lose everything) and store them in Postgres (image_blobs).
  let receiptsStored = 0;
  let receiptsSkipped = 0;
  const imageKeys = new Map<string, { key: string; mime: string }>(); // txn -> stored image

  if (!DRY_RUN) {
    for (const t of transactions) {
      if (!t.receiptURL) {
        receiptsSkipped++;
        continue;
      }
      const img = await downloadReceipt(
        t.receiptURL,
        t.receiptType,
        t.receiptFilename,
      );
      if (!img) {
        receiptsSkipped++;
        continue;
      }
      const ext = mimeToExt(img.mime);
      const keyName = `${t.date}_${t.reportName.replace(/\s+/g, "_")}_${t.transactionID}${ext}`;
      const pathname = `images/${accountId}/${keyName}`;
      await prisma.imageBlob.upsert({
        where: { accountId_key: { accountId, key: pathname } },
        create: {
          accountId,
          key: pathname,
          mime: img.mime,
          data: new Uint8Array(img.buffer),
        },
        update: {
          mime: img.mime,
          data: new Uint8Array(img.buffer),
        },
      });
      imageKeys.set(t.transactionID, { key: pathname, mime: img.mime });
      receiptsStored++;
      if (receiptsStored % 25 === 0)
        console.info(`  ${receiptsStored} receipts stored …`);
    }
    console.info(
      `Receipts: ${receiptsStored} stored, ${receiptsSkipped} skipped (pg)`,
    );
  } else {
    console.info(
      `[dry-run] receipt downloads skipped (${transactions.filter((t) => t.receiptURL).length} have receipts; pass a session cookie to store them)`,
    );
  }

  // Rebuild the expenses table for this account.
  const now = new Date().toISOString();
  const rows = transactions.map((t) => {
    const image = imageKeys.get(t.transactionID);
    return {
      id: ulid(),
      type: "receipt",
      date: t.date,
      report: reportSpelling.get(t.reportName.toLowerCase()) ?? t.reportName,
      category: categorySpelling.get(t.category.toLowerCase()) ?? t.category,
      description: t.comment,
      amount: t.amount,
      merchant: t.merchant,
      imageFile: image?.key ?? "",
      imageMime: image?.mime ?? "",
      originalName: t.receiptFilename || "",
      distanceMiles: "",
      locations: [],
      createdAt: now,
      updatedAt: now,
      accountId,
    };
  });

  if (DRY_RUN) {
    console.info(
      `[dry-run] would replace expenses for account ${accountId}: ` +
        `${await prisma.expense.count({ where: { accountId } })} -> ${rows.length}`,
    );
    return { receiptsStored, receiptsSkipped };
  }

  await prisma.$transaction([
    prisma.expense.deleteMany({ where: { accountId } }),
    prisma.expense.createMany({ data: rows }),
  ]);
  console.info(
    `Replaced expenses: ${rows.length} rows for account ${accountId}`,
  );
  return { receiptsStored, receiptsSkipped };
}

async function main(): Promise<void> {
  const transactions = await exportTransactions();
  if (transactions.length === 0) {
    console.error("No transactions exported — aborting");
    process.exit(1);
  }
  const { receiptsStored, receiptsSkipped } = await reconcile(transactions);
  console.info(
    `Done. ${transactions.length} expenses, ${receiptsStored} receipts stored, ${receiptsSkipped} without receipt.`,
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Import failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
