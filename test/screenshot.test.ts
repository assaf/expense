import { spawn } from "node:child_process";
/**
 * README + landing screenshot generator, skipped unless SCREENSHOT=1.
 *
 *   SCREENSHOT=1 pnpm exec vp test run test/screenshot.test.ts
 *
 * Reuses the test-suite harness: seeds expense_test with a realistic mock
 * dataset (real-ish merchants, reports, categories, generated receipt
 * images), boots the app server, signs in through the real login flow, and
 * captures full-page screenshots with Playwright into public/.
 *
 * Also regenerates the landing page's marketing images: the hero is a
 * viewport crop of the same home capture and the og card its 1200x630 top
 * slice, so all three stay in sync with the current UI (run this after any
 * home-page redesign and commit the refreshed public/screenshot-*.png).
 * The suite-screenshot drift block below skips during SCREENSHOT runs: the
 * README seeder replaces the shared seed state the drift block compares
 * against, so the two modes must not interleave.
 *
 * Inside the normal suite (`pnpm test`) the whole describe block is skipped,
 * so it never slows or pollutes the regular test run.
 */
import sharp from "sharp";
import { ulid } from "ulid";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { hashPassword } from "~/lib/passwords";
import {
  extractionCacheKey,
  readCachedExtraction,
  writeCachedExtraction,
} from "~/lib/db/extraction-cache";
import { extractPdfText } from "~/lib/receipt-ocr.server";
import { createDemoRecorder } from "./helpers/demoRecord";
import { fileTransfer } from "./helpers/dropFile";
import { closeServer, launchServer } from "./helpers/launchServer";
import {
  freshPage,
  closeBrowser,
  goto,
  signIn,
  waitForHydration,
} from "./helpers/launchBrowser";
import type { Page } from "playwright";
import { removeDiffImages } from "./helpers/toMatchScreenshot";
import { confirmationEmail } from "~/lib/email-confirmation.server";
import { replyHtml } from "~/lib/inbound-email.server";
import { verificationEmailHtml } from "~/lib/verification-email.server";
import {
  TEST_ACCOUNT_ID,
  TEST_EMAIL,
  TEST_PASSWORD,
  testPrisma,
} from "./helpers/seedTestData";

const ACCOUNT = "acct_screenshot";
const NOW = "2026-07-31T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Mock dataset
// ---------------------------------------------------------------------------

const REPORTS = ["July 2026", "Q2 Travel", "Q2 Office"];

const CATEGORIES = [
  "Travel",
  "Meals & Entertainment",
  "Office Supplies",
  "Software",
  "Client Meetings",
];

interface ReceiptSpec {
  merchant: string;
  date: string;
  amount: string;
  category: string;
  report: string;
  accent: string;
  items: [string, string][];
}

const RECEIPTS: ReceiptSpec[] = [
  {
    merchant: "Apple Store",
    date: "2026-06-20",
    amount: "129.00",
    category: "Software",
    report: "Q2 Office",
    accent: "#1d1d1f",
    items: [["Magic Keyboard", "129.00"]],
  },
  {
    merchant: "Figma",
    date: "2026-06-23",
    amount: "15.00",
    category: "Software",
    report: "Q2 Office",
    accent: "#0d99ff",
    items: [["Figma Professional · monthly", "15.00"]],
  },
  {
    merchant: "Delta Air Lines",
    date: "2026-06-24",
    amount: "412.50",
    category: "Travel",
    report: "Q2 Travel",
    accent: "#0a3d91",
    items: [
      ["LAX → SFO", "192.50"],
      ["SFO → LAX", "192.50"],
      ["Airport fee", "12.50"],
      ["Seat selection", "15.00"],
    ],
  },
  {
    merchant: "Airbnb",
    date: "2026-06-26",
    amount: "186.00",
    category: "Travel",
    report: "Q2 Travel",
    accent: "#e03e3e",
    items: [
      ["2 nights · Venice Beach", "160.00"],
      ["Cleaning fee", "26.00"],
    ],
  },
  {
    merchant: "Amazon.com",
    date: "2026-06-27",
    amount: "59.99",
    category: "Office Supplies",
    report: "Q2 Office",
    accent: "#232f3e",
    items: [["Logitech MX Master 3S", "59.99"]],
  },
  {
    merchant: "Lyft",
    date: "2026-06-30",
    amount: "18.40",
    category: "Travel",
    report: "Q2 Travel",
    accent: "#7a28c7",
    items: [
      ["Ride · 3.2 mi", "14.28"],
      ["Service fee", "2.17"],
      ["Booking fee", "1.95"],
    ],
  },
  {
    merchant: "Sweetgreen",
    date: "2026-07-14",
    amount: "18.75",
    category: "Meals & Entertainment",
    report: "July 2026",
    accent: "#1c7c54",
    items: [
      ["Harvest Bowl", "13.75"],
      ["Sparkling water", "5.00"],
    ],
  },
  {
    merchant: "Peet's Coffee",
    date: "2026-07-16",
    amount: "9.20",
    category: "Meals & Entertainment",
    report: "July 2026",
    accent: "#4a2616",
    items: [
      ["Cappuccino", "5.45"],
      ["Ham & cheese croissant", "3.75"],
    ],
  },
  {
    merchant: "Trader Joe's",
    date: "2026-07-19",
    amount: "32.10",
    category: "Meals & Entertainment",
    report: "July 2026",
    accent: "#c8102e",
    items: [
      ["Oat milk", "3.49"],
      ["Avocados ×4", "4.99"],
      ["Salmon fillet", "11.20"],
      ["Coffee beans", "12.42"],
    ],
  },
];

/** Incomplete receipt: demos the amber "Incomplete" state on the home page. */
const INCOMPLETE = {
  merchant: "",
  date: "2026-07-27",
  amount: null,
  category: "Meals & Entertainment",
  report: "",
  description: "Team lunch — receipt later",
};

const MILEAGE = {
  date: "2026-07-22",
  report: "July 2026",
  category: "Client Meetings",
  description: "Client visit",
  distanceMiles: "14.2",
  amount: "9.94",
  locations: [
    { address: "Venice Beach, CA", lat: 33.985, lng: -118.4695 },
    { address: "Santa Monica Pier, CA", lat: 34.0086, lng: -118.4977 },
    { address: "Culver City, CA", lat: 34.0211, lng: -118.3965 },
  ],
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random barcode bars from a seed string. */
function lcg(seed: string): () => number {
  let s = 7;
  for (const c of seed) s = (s + c.charCodeAt(0) * 31) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
}

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
}

/** Draw a small, realistic-looking receipt card as SVG. */
function receiptSvg(spec: ReceiptSpec): string {
  const rand = lcg(spec.merchant);
  let bars = "";
  let x = 24;
  while (x < 296) {
    const w = 2 + (rand() % 3);
    bars += `<rect x="${x}" y="348" width="${w}" height="50" fill="#111827"/>`;
    x += w + 2;
  }
  let digits = "";
  for (const c of spec.merchant) {
    if (digits.length >= 12) break;
    digits += String(c.charCodeAt(0) % 10);
  }

  const rows = spec.items
    .map(([name, price], i) => {
      const y = 128 + i * 30;
      return `
      <text x="24" y="${y}" font-size="15" fill="#1f2937" font-family="Helvetica, Arial, sans-serif">${esc(name)}</text>
      <text x="296" y="${y}" text-anchor="end" font-size="15" fill="#1f2937" font-family="Helvetica, Arial, sans-serif">$${price}</text>
      <line x1="24" y1="${y + 8}" x2="296" y2="${y + 8}" stroke="#e5e7eb" stroke-width="1" stroke-dasharray="2 3"/>`;
    })
    .join("\n");

  return `<svg width="320" height="440" xmlns="http://www.w3.org/2000/svg">
  <rect width="320" height="440" fill="#faf9f6"/>
  <rect width="320" height="92" fill="${spec.accent}"/>
  <text x="24" y="48" font-size="24" font-weight="700" fill="#ffffff" font-family="Helvetica, Arial, sans-serif">${esc(spec.merchant)}</text>
  <text x="24" y="72" font-size="13" letter-spacing="2" fill="rgba(255,255,255,0.85)" font-family="Helvetica, Arial, sans-serif">RECEIPT · ${spec.date}</text>
  <text x="296" y="108" text-anchor="end" font-size="12" fill="#9ca3af" font-family="Helvetica, Arial, sans-serif">#${spec.date.replaceAll("-", "")}</text>
  ${rows}
  <text x="24" y="258" font-size="13" fill="#6b7280" font-family="Helvetica, Arial, sans-serif">SUBTOTAL</text>
  <text x="296" y="258" text-anchor="end" font-size="13" fill="#6b7280" font-family="Helvetica, Arial, sans-serif">$${spec.amount}</text>
  <text x="24" y="282" font-size="13" fill="#6b7280" font-family="Helvetica, Arial, sans-serif">TAX</text>
  <text x="296" y="282" text-anchor="end" font-size="13" fill="#6b7280" font-family="Helvetica, Arial, sans-serif">$0.00</text>
  <line x1="24" y1="296" x2="296" y2="296" stroke="#9ca3af" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="24" y="330" font-size="20" font-weight="700" fill="#111827" font-family="Helvetica, Arial, sans-serif">TOTAL</text>
  <text x="296" y="330" text-anchor="end" font-size="20" font-weight="700" fill="#111827" font-family="Helvetica, Arial, sans-serif">$${spec.amount}</text>
  ${bars}
  <text x="24" y="422" font-size="12" letter-spacing="6" fill="#374151" font-family="monospace">${digits}</text>
</svg>`;
}

async function seedScreenshotData() {
  // Wipe everything; accounts cascade to users + all scoped rows.
  await testPrisma.account.deleteMany({});

  await testPrisma.account.create({
    data: {
      id: ACCOUNT,
      name: "Screenshot Account",
      inviteCode: "SHOT1",
      createdAt: NOW,
    },
  });
  await testPrisma.user.create({
    data: {
      id: "user_screenshot",
      accountId: ACCOUNT,
      email: TEST_EMAIL,
      passwordHash: await hashPassword(TEST_PASSWORD),
      // Email verification gates sign-in; the capture user is pre-verified.
      emailVerifiedAt: NOW,
      createdAt: NOW,
    },
  });
  await testPrisma.report.createMany({
    data: REPORTS.map((name) => ({ name, accountId: ACCOUNT })),
    skipDuplicates: true,
  });
  await testPrisma.category.createMany({
    data: CATEGORIES.map((name) => ({ name, accountId: ACCOUNT })),
    skipDuplicates: true,
  });
  await testPrisma.settings.createMany({
    data: [
      {
        accountId: ACCOUNT,
        key: "homeAddress",
        value: "1700 Pacific Ave, Venice, CA",
      },
      { accountId: ACCOUNT, key: "homeLat", value: "33.985" },
      { accountId: ACCOUNT, key: "homeLng", value: "-118.4695" },
    ],
  });

  // Receipts with generated receipt images (stored in image_blobs, like the
  // app does; all images live in Postgres).
  for (const spec of RECEIPTS) {
    const png = await sharp(Buffer.from(receiptSvg(spec)), { density: 144 })
      .png()
      .toBuffer();
    const slug = spec.merchant.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
    const key = `images/${ACCOUNT}/${spec.date}_${slug}.png`;
    await testPrisma.imageBlob.create({
      data: {
        accountId: ACCOUNT,
        key,
        mime: "image/png",
        data: new Uint8Array(png),
      },
    });
    await testPrisma.expense.create({
      data: {
        id: ulid(),
        accountId: ACCOUNT,
        type: "receipt",
        date: spec.date,
        report: spec.report,
        category: spec.category,
        description: "",
        amount: spec.amount,
        merchant: spec.merchant,
        imageFile: key,
        imageMime: "image/png",
        originalName: `${spec.date}_${slug}.png`,
        distanceMiles: null,
        locations: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
  }

  // Mileage expense with a real-looking LA route (map thumbnail).
  await testPrisma.expense.create({
    data: {
      id: ulid(),
      accountId: ACCOUNT,
      type: "mileage",
      date: MILEAGE.date,
      report: MILEAGE.report,
      category: MILEAGE.category,
      description: MILEAGE.description,
      amount: MILEAGE.amount,
      merchant: "",
      imageFile: "",
      imageMime: "",
      originalName: "",
      distanceMiles: MILEAGE.distanceMiles,
      locations: MILEAGE.locations,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  // Incomplete receipt (amber highlight demo).
  await testPrisma.expense.create({
    data: {
      id: ulid(),
      accountId: ACCOUNT,
      type: "receipt",
      date: INCOMPLETE.date,
      report: INCOMPLETE.report,
      category: INCOMPLETE.category,
      description: INCOMPLETE.description,
      amount: INCOMPLETE.amount,
      merchant: INCOMPLETE.merchant,
      imageFile: "",
      imageMime: "",
      originalName: "",
      distanceMiles: null,
      locations: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
}

// ---------------------------------------------------------------------------
// Screenshot capture
// ---------------------------------------------------------------------------

/** Downscale a captured screenshot to a reasonable README width. */
async function shrinkForReadme(path: string): Promise<void> {
  await sharp(path).resize({ width: 1600 }).png().toFile(`${path}.tmp`);
  const { rename } = await import("node:fs/promises");
  await rename(`${path}.tmp`, path);
}
/** Wait for React to attach (fiber keys, not just the bundle globals) and
 * every image to finish loading and decoding. */
async function waitForSettled(page: Page): Promise<void> {
  // React attached (fiber keys): a capture taken while the bundle has run
  // but React has not attached diffs every client-rendered detail.
  await waitForHydration(page);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("img")].every((img) => img.complete),
  );
  // Complete is not painted: a large PNG (the landing's app screenshots) can
  // be loaded and still rasterize late, so a full-page capture catches it as
  // a patch of noise. Decode every image before the screenshot.
  await page.evaluate(() =>
    Promise.all(
      [...document.querySelectorAll("img")].map((img) =>
        img.decode().catch(() => {}),
      ),
    ),
  );
}

/** Reuse the globalSetup server already listening on 5199 rather than
 * spawning a second instance. Returns whether this call launched it. */
async function ensureServer(): Promise<boolean> {
  const baseURL = "http://127.0.0.1:5199";
  try {
    await fetch(`${baseURL}/login`, { signal: AbortSignal.timeout(3_000) });
    return false;
  } catch {
    await launchServer();
    return true;
  }
}

async function captureHome(page: Page): Promise<void> {
  await page.goto("/expenses", { waitUntil: "load" });
  await waitForSettled(page);
  // Give map tiles (OSM) and webfonts a moment to arrive.
  await page.waitForTimeout(3_000);

  // Structural checks: the screenshot must show the seeded dataset.
  await expect
    .poll(() => page.locator("main li").count(), { timeout: 10_000 })
    .toBe(11); // 9 receipts + mileage + 1 incomplete
  expect(await page.getByText("Incomplete").count()).toBe(1);
  expect(await page.getByText("July 2026").count()).toBeGreaterThan(0);
  expect(await page.getByText("Q2 Travel").count()).toBeGreaterThan(0);
  // The seeded mileage row renders (description is its label on home).
  expect(await page.getByText("Client visit").count()).toBe(1);

  await page.screenshot({ path: "public/screenshot-home.png", fullPage: true });
  await shrinkForReadme("public/screenshot-home.png");

  // The landing page frames a viewport crop of the same home page as its
  // hero, and the og card is the hero's top slice at social-card size.
  // Regenerating them here keeps all three in sync with the current UI.
  await page.screenshot({ path: "public/screenshot-hero.png" });
  await shrinkForReadme("public/screenshot-hero.png");
  await sharp("public/screenshot-hero.png")
    .resize(1200, 630, { fit: "cover", position: "top" })
    .png()
    .toFile("public/screenshot-og.png");
}

describe.skipIf(!process.env.SCREENSHOT)("README screenshots", () => {
  it("seeds mock data and captures the home + receipt editor pages", async () => {
    await seedScreenshotData();

    const launched = await ensureServer();

    try {
      const page = await freshPage({
        viewport: { width: 1440, height: 940 },
        deviceScaleFactor: 2,
      });
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(String(err)));
      await signIn(page, TEST_EMAIL, TEST_PASSWORD);

      await captureHome(page);
      console.info("wrote public/screenshot-home.png");

      // Receipt editor page: show a receipt with the generated image.
      const sweetgreen = await testPrisma.expense.findFirstOrThrow({
        where: { accountId: ACCOUNT, merchant: "Sweetgreen" },
        select: { id: true },
      });
      await page.goto(`/expense/${sweetgreen.id as string}`, {
        waitUntil: "load",
      });
      await waitForSettled(page);
      await expect
        .poll(() => page.getByLabel("Merchant").inputValue(), {
          timeout: 10_000,
        })
        .toBe("Sweetgreen");
      await expect
        .poll(() => page.getByLabel("Amount").inputValue(), {
          timeout: 10_000,
        })
        .toBe("18.75");
      await page.screenshot({
        path: "public/screenshot-expense.png",
        fullPage: true,
      });
      await shrinkForReadme("public/screenshot-expense.png");
      console.info("wrote public/screenshot-expense.png");
      expect(pageErrors).toEqual([]);
    } finally {
      await closeBrowser();
      if (launched) await closeServer();
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Landing demo
// ---------------------------------------------------------------------------

/** The receipt the demo drops, and the fields it says: a PDF with a text
 * layer, so the app reads it the way it reads a downloaded receipt
 * (extractPdfText, then the model). */
const DEMO_RECEIPT = {
  merchant: "Blue Bottle Coffee",
  amount: "24.75",
  category: "Meals & Entertainment",
  date: "2026-07-15",
  items: [
    ["Iced latte x2", "13.50"],
    ["Avocado toast", "11.25"],
  ] as [string, string][],
};

/** Draw the demo receipt as a PDF. The layout is the receipt's own: the text
 * layer is what the extraction reads, and the rasterized page is what the
 * editor shows in the video. */
async function demoReceiptPdf(): Promise<Buffer> {
  const { default: PDFDocument } = await import("pdfkit");
  const doc = new PDFDocument({ size: [420, 600], margin: 36 });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const written = new Promise<void>((resolve) => doc.on("end", resolve));

  doc.font("Helvetica-Bold").fontSize(19).fillColor("#111827");
  doc.text("BLUE BOTTLE COFFEE", { characterSpacing: 0.5 });
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(9.5).fillColor("#4b5563");
  doc.text("300 Webster St, Oakland CA");
  doc.text("510-653-3394  ·  bluebottlecoffee.com");
  doc.moveDown(0.8);
  doc.moveTo(36, doc.y).lineTo(384, doc.y).strokeColor("#9ca3af").stroke();
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111827");
  doc.text(`Receipt ${DEMO_RECEIPT.date}`);
  doc.font("Helvetica").fontSize(9.5).fillColor("#4b5563");
  doc.text("Order 4821  ·  Register 2  ·  Barista: Sam");
  doc.moveDown(1.1);
  for (const [name, price] of DEMO_RECEIPT.items) {
    const y = doc.y;
    doc.font("Helvetica").fontSize(11).fillColor("#111827");
    doc.text(name, 36, y);
    doc.text(`$${price}`, 284, y, { width: 100, align: "right" });
    doc.moveDown(0.7);
  }
  doc.moveDown(0.4);
  doc.moveTo(36, doc.y).lineTo(384, doc.y).strokeColor("#9ca3af").stroke();
  doc.moveDown(0.9);
  const totalY = doc.y;
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827");
  doc.text("TOTAL", 36, totalY);
  doc.text(`$${DEMO_RECEIPT.amount}`, 284, totalY, {
    width: 100,
    align: "right",
  });
  doc.moveDown(1.6);
  doc.font("Helvetica").fontSize(9.5).fillColor("#4b5563");
  doc.text("VISA ****4821  ·  Approved  ·  Thank you");
  doc.end();
  await written;
  return Buffer.concat(chunks);
}

/** Warm the extraction cache with the answer that belongs to this exact file.
 *
 * The model call is the one step the demo cannot make: the suite forbids
 * outbound network (app/lib/env.ts), and a live call would make the video
 * depend on a provider. A cache row is what the app reads on a re-upload
 * anyway, so the demo shows the app's own fill path with the model's answer
 * already in place. A drifted key would leave the fields empty, so this
 * proves the read back rather than trusting the write. */
async function warmDemoExtraction(pdf: Buffer): Promise<void> {
  const text = await extractPdfText(pdf);
  const key = extractionCacheKey({ text });
  if (!key)
    throw new Error("demo: the receipt PDF has no text layer to key on");
  await writeCachedExtraction(ACCOUNT, key, {
    isReceipt: true,
    merchant: DEMO_RECEIPT.merchant,
    description: "",
    amount: DEMO_RECEIPT.amount,
    currency: "USD",
    category: DEMO_RECEIPT.category,
    report: "",
    confidence: "high",
    notes: "",
  });
  const cached = await readCachedExtraction(ACCOUNT, key);
  expect(cached).toMatchObject({
    merchant: DEMO_RECEIPT.merchant,
    amount: DEMO_RECEIPT.amount,
  });
}

/**
 * Landing hero demo: the receipt a visitor drops on the list, from the drop to
 * the filed expense. Skipped unless DEMO=1 (`pnpm demo`), because it encodes a
 * video and needs ffmpeg; the artifact is committed, so the suite never builds
 * it. The recording is a sequence of frames with explicit holds (see
 * helpers/demoRecord) so the cut is the same on every run.
 */
describe.skipIf(!process.env.DEMO)("landing demo", () => {
  it("records the drop-a-receipt demo", async () => {
    await seedScreenshotData();
    const pdf = await demoReceiptPdf();
    await warmDemoExtraction(pdf);

    const launched = await ensureServer();

    try {
      const page = await freshPage({
        viewport: { width: 1440, height: 940 },
        deviceScaleFactor: 2,
      });
      const recorder = await createDemoRecorder(page);
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(String(err)));
      await signIn(page, TEST_EMAIL, TEST_PASSWORD);

      // Scene 1: the expense list, as a user finds it.
      await page.goto("/expenses", { waitUntil: "load" });
      await waitForSettled(page);
      await page.waitForTimeout(3_000);
      // The demo's claim is that this list gains a row by the end, so both
      // ends of that are asserted rather than left to the eye.
      await expect
        .poll(() => page.locator("main li").count(), { timeout: 10_000 })
        .toBe(11);
      await recorder.place(1080, 720);
      await recorder.shot(2_200);

      // Scene 2: a receipt file arrives over the page. The file is let go on
      // the page itself, not on the column: the listener is on the document,
      // and what lights up is the column (the app's own outline).
      const main = page.locator("#main-content");
      const hovering = await fileTransfer(page, {
        name: "blue-bottle-receipt.pdf",
        type: "application/pdf",
        body: [...pdf],
      });
      await page
        .locator("body")
        .dispatchEvent("dragenter", { dataTransfer: hovering });
      await page
        .locator("body")
        .dispatchEvent("dragover", { dataTransfer: hovering });
      await expect
        .poll(() => main.getAttribute("class"), { timeout: 10_000 })
        .toContain("outline-dashed");
      // Carry the pointer into the page with the outline up: the drag reads as
      // motion rather than a highlight that appears over a still cursor.
      await recorder.glideTo(760, 470);
      await recorder.shot(1_400);

      // Scene 3: the drop opens the new-expense editor on the file as its
      // draft, which rasterizes the PDF and reads its fields.
      const dropping = await fileTransfer(page, {
        name: "blue-bottle-receipt.pdf",
        type: "application/pdf",
        body: [...pdf],
      });
      await page
        .locator("body")
        .dispatchEvent("drop", { dataTransfer: dropping });
      await page.waitForURL(/\/expense\/new/, { timeout: 15_000 });
      await waitForSettled(page);
      await recorder.shot(1_000);
      await expect
        .poll(() => page.getByLabel("Merchant").inputValue(), {
          timeout: 20_000,
        })
        .toBe(DEMO_RECEIPT.merchant);
      await expect
        .poll(() => page.getByLabel("Amount").inputValue(), { timeout: 20_000 })
        .toBe(DEMO_RECEIPT.amount);
      await recorder.shot(1_800);

      // Scene 4: file it. Pick the report and describe it, then save.
      await recorder.click(page.getByLabel("Report"));
      await recorder.shot(600);
      await page.getByLabel("Report").selectOption("July 2026");
      await recorder.shot(900);
      await recorder.typeInto(
        page.getByLabel("Description"),
        "Client coffee with Sam",
      );
      await recorder.shot(700);

      // Scene 5: the save returns to the list with the new expense on it.
      await recorder.click(page.getByRole("button", { name: /^Save/ }));
      await page.waitForURL(/\/expenses\?new=/, { timeout: 20_000 });
      await waitForSettled(page);
      await recorder.shot(1_400);
      await recorder.shot(1_800);
      expect(await page.getByText(DEMO_RECEIPT.merchant).count()).toBe(1);
      await expect
        .poll(() => page.locator("main li").count(), { timeout: 10_000 })
        .toBe(12);

      const result = await recorder.finish({
        width: 1440,
        height: 940,
        poster: "public/demo-receipt-poster.webp",
        mp4: "public/demo-receipt.mp4",
        webm: "public/demo-receipt.webm",
      });
      console.info(
        `wrote public/demo-receipt.{mp4,webm} (${result.frames} frames, ${result.seconds.toFixed(1)}s)`,
      );
      expect(pageErrors).toEqual([]);
    } finally {
      await closeBrowser();
      if (launched) await closeServer();
    }
  }, 600_000);
});

/**
 * Suite screenshot regression: on every `pnpm test` run, capture the app's
 * important screens and the emails it sends, comparing each against the
 * committed baseline in screenshots/ (see toMatchBaseline). Uses whatever
 * state the suite has left in expense_test, so the shots reflect the same
 * data the tests verified. Fails loudly: a screen that throws, never
 * hydrates, or drifts from its baseline is a broken screen, not a missing
 * artifact. Review drift with `pnpm screenshots:review`.
 */
describe.skipIf(process.env.SCREENSHOT)("suite screenshots", () => {
  /** Drift findings across all captures, asserted empty at the end so one
   * run surfaces every drifted screen (and leaves its diff artifacts),
   * not just the first. Client-side exceptions are collected alongside:
   * a screen can render plausibly and still be broken. */
  const drift: string[] = [];
  const pageErrors: string[] = [];

  // Any drift opens the review UI (baseline vs new side by side, A accepts,
  // Esc closes): the failure alone names files, the comparison is where the
  // decision happens. Detached + unref'd so the vitest fork can exit; the
  // server stops itself after the last item or when the tab closes. Never
  // fires in CI, where comparisons are skipped and drift cannot occur.
  afterAll(() => {
    if (drift.length === 0 || process.env.CI) return;
    spawn("pnpm", ["screenshots:review"], {
      detached: true,
      stdio: "ignore",
    }).unref();
  });
  let currentName = "";

  /** Hydration + image settle, then a compared capture. The pinned clock
   * (freezePageClock) keeps client-rendered dates stable across runs. */
  async function capture(
    page: Page,
    path: string,
    name: string,
    opts: { reducedMotion?: boolean } = {},
  ): Promise<void> {
    currentName = name;
    // The landing page plays a video, and a playing video is never the same
    // twice. Capturing it with reduced motion compares the still the page
    // shows instead, which keeps the baseline stable and keeps that path
    // covered by the suite.
    await page.emulateMedia({
      reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
    });
    await page.goto(path, { waitUntil: "load", timeout: 15_000 });
    await waitForSettled(page);
    // Post-mount rendering: <LocalDate> swaps ISO for local format, the
    // dashboard computes future badges after hydration.
    try {
      await expect(page).toMatchBaseline({ name, fullPage: true });
    } catch (error) {
      drift.push(`${name}: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  it("captures the important screens into screenshots/", async () => {
    // Stale .new/.diff artifacts from earlier failed runs would otherwise
    // pile up; baselines themselves are never touched here.
    await removeDiffImages();

    const launched = await ensureServer();

    try {
      // Logged-out surfaces.
      const fresh = await freshPage({ viewport: { width: 1280, height: 800 } });
      fresh.on("pageerror", (error) =>
        pageErrors.push(`${currentName}: ${String(error)}`),
      );
      await capture(fresh, "/", "landing", { reducedMotion: true });
      await capture(fresh, "/login", "login");
      await capture(fresh, "/onboarding", "onboarding");
      await fresh.close();

      // Signed-in surfaces on the shared (test-credential) session.
      const page = await goto("/expenses");
      page.on("pageerror", (error) =>
        pageErrors.push(`${currentName}: ${String(error)}`),
      );
      await capture(page, "/expenses", "home");
      await capture(page, "/expense/new", "expense-new");
      await capture(page, "/insights", "insights");

      // The editor needs a real expense row: the seeded Test Store receipt.
      // Target it by merchant, never by an unordered `findFirst`: the seed
      // also holds a deliberately incomplete row (2026-01-01, amount 0.00,
      // no merchant) and whichever one Postgres returns first depends on the
      // plan, so the capture would silently show an empty editor.
      let editor = await testPrisma.expense.findFirst({
        where: { accountId: TEST_ACCOUNT_ID, merchant: "Test Store" },
        select: { id: true },
      });
      if (!editor) {
        editor = await testPrisma.expense.create({
          data: {
            id: ulid(),
            accountId: TEST_ACCOUNT_ID,
            type: "receipt",
            date: "2026-01-15",
            report: "2026 Test",
            category: "Testing",
            description: "",
            amount: 42.5,
            merchant: "Test Store",
            imageFile: "",
            imageMime: "",
            originalName: "",
            locations: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          select: { id: true },
        });
      }
      // Prisma's generated create-result type is loose here (see the same
      // cast in the README block above).
      const editorId = editor.id as string;
      await capture(page, `/expense/${editorId}`, "expense-editor");

      await capture(page, "/emails", "emails");
      await capture(page, "/email-review", "email-review");
      await capture(page, "/reconcile", "reconcile");
      await capture(page, "/settings", "settings");
      await capture(page, "/mileage-rates", "mileage-rates");
      await capture(page, "/export", "export");
      await capture(page, "/ai", "ai");
    } finally {
      await closeBrowser();
      if (launched) await closeServer();
    }
    const findings = [...drift, ...pageErrors];
    if (findings.length > 0) {
      throw new Error(
        `${findings.length} screenshot problem(s):\n` + findings.join("\n"),
      );
    }
  }, 240_000);

  it("captures the emails the app sends into screenshots/emails/", async () => {
    // Artifacts from the screens test must survive for review, so this
    // block does NOT call removeDiffImages.
    const ORIGIN = "https://expense.example.com";
    const emails: Array<[string, string]> = [
      // account-verification.server.ts copy
      [
        "verification",
        verificationEmailHtml({
          token: "screenshot-token",
          origin: ORIGIN,
          verifyPath: "/verify-email",
          buttonLabel: "Verify your email",
          body: [
            "You signed up for <b>Personal</b> on Expense with <b>you@example.com</b>. Click below to confirm this address is yours and activate the account:",
          ],
          closingNote:
            "You'll be able to sign in once the address is verified. This link expires in 7 days — if it has expired, sign in and use the resend button. If you didn't create this account, you can ignore this email.",
        }),
      ],
      // auth.server.ts requestPasswordReset copy
      [
        "password-reset",
        verificationEmailHtml({
          token: "screenshot-token",
          origin: ORIGIN,
          verifyPath: "/reset-password",
          buttonLabel: "Set a new password",
          body: [
            "We got a request to reset the password for <b>you@example.com</b> on <b>Personal</b>.",
            "Click below to choose a new password. The link is single-use and expires in 7 days.",
          ],
          closingNote:
            "If you didn't request this, you can ignore this email — your password stays the same.",
        }),
      ],
      // email-confirmation.server.ts receipt confirmation (complete import)
      [
        "receipt-confirmation",
        confirmationEmail({
          expenseId: "01J00000000000000000000000",
          date: "2026-08-30",
          merchant: "Harris Restaurant",
          amount: "84.20",
          category: "Meals",
          report: "2026 Business",
          description: "Client dinner",
          notes: "Amount is in USD.",
          missing: [],
        }).html,
      ],
      // inbound-email.server.ts auth-failure reply (INB-SPOOF-1 path)
      [
        "receipt-not-imported",
        replyHtml("Receipt not imported — message failed authentication", [
          "We received an email claiming to be from <b>deals@merchant.example</b>, but it failed SPF/DKIM/DMARC authentication, so it was not imported (a forged sender address could otherwise add fake expenses).",
          "If this was a legitimate receipt, forward it from an address you've verified under Email → Receipts by email (your own address works — a forward carries your mail server's authentication, which we accept). If the merchant's own mail keeps failing, that service needs to fix its mail authentication.",
        ]),
      ],
    ];

    const seen = drift.length;
    const page = await freshPage({ viewport: { width: 720, height: 900 } });
    try {
      for (const [name, html] of emails) {
        await page.setContent(html, { waitUntil: "load" });
        try {
          await expect(page).toMatchBaseline({
            name: `emails/${name}`,
            fullPage: true,
          });
        } catch (error) {
          drift.push(
            `emails/${name}: ${(error as Error).message.split("\n")[0]}`,
          );
        }
      }
    } finally {
      await page.close();
      await closeBrowser();
    }
    if (drift.length > seen) {
      throw new Error(
        `${drift.length - seen} email screenshot(s) differ from baseline:\n` +
          drift.slice(seen).join("\n"),
      );
    }
  }, 60_000);
});
