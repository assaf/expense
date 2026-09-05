/**
 * README screenshot generator, skipped unless SCREENSHOT=1.
 *
 *   SCREENSHOT=1 pnpm exec vp test run test/screenshot.test.ts
 *
 * Reuses the test-suite harness: seeds expense_test with a realistic mock
 * dataset (real-ish merchants, reports, categories, generated receipt
 * images), boots the app server, signs in through the real login flow, and
 * captures full-page screenshots with Playwright into public/.
 *
 * Inside the normal suite (`pnpm test`) the whole describe block is skipped,
 * so it never slows or pollutes the regular test run.
 */
import sharp from "sharp";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { hashPassword } from "~/lib/passwords";
import { closeServer, launchServer } from "./helpers/launchServer";
import { freshPage, closeBrowser, goto, signIn } from "./helpers/launchBrowser";
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

async function captureHome(page: import("playwright").Page): Promise<void> {
  await page.goto("/", { waitUntil: "load" });
  await page.waitForFunction(() => "__reactRouterContext" in window);
  // Wait for every thumbnail image to finish loading.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("img")].every((img) => img.complete),
  );
  // Give map tiles (OSM) and webfonts a moment to arrive.
  await page.waitForTimeout(3_000);

  // Structural checks: the screenshot must show the seeded dataset.
  await expect
    .poll(() => page.locator("main li").count(), { timeout: 10_000 })
    .toBe(11); // 9 receipts + mileage + 1 incomplete
  expect(await page.locator("main section button").count()).toBe(4); // reports
  expect(await page.locator("main li img:not(.leaflet-tile)").count()).toBe(9); // receipt thumbs
  expect(await page.getByText("Incomplete").count()).toBe(1);
  expect(await page.getByText("July 2026").count()).toBeGreaterThan(0);
  expect(await page.getByText("Q2 Travel").count()).toBeGreaterThan(0);
  expect(
    await page.getByText(/Current mileage rate: \$0\.7\d\/mi\./).count(),
  ).toBe(1);

  await page.screenshot({ path: "public/screenshot-home.png", fullPage: true });
  await shrinkForReadme("public/screenshot-home.png");
}

describe.skipIf(!process.env.SCREENSHOT)("README screenshots", () => {
  it("seeds mock data and captures the home + receipt editor pages", async () => {
    await seedScreenshotData();

    // The globalSetup server is usually already listening on 5199; reuse it
    // rather than spawning a second instance.
    let baseURL = "http://127.0.0.1:5199";
    let launched = false;
    try {
      await fetch(`${baseURL}/login`, { signal: AbortSignal.timeout(3_000) });
    } catch {
      baseURL = await launchServer();
      launched = true;
    }

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
      await page.waitForFunction(() => "__reactRouterContext" in window);
      await page.waitForFunction(() =>
        [...document.querySelectorAll("img")].every((img) => img.complete),
      );
      await page.waitForTimeout(1_500);
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

/**
 * Suite screenshot regression: on every `pnpm test` run, capture the app's
 * important screens and the emails it sends, comparing each against the
 * committed baseline in screenshots/ (see toMatchScreenshot). Uses whatever
 * state the suite has left in expense_test, so the shots reflect the same
 * data the tests verified. Fails loudly: a screen that throws, never
 * hydrates, or drifts from its baseline is a broken screen, not a missing
 * artifact. Review drift with `pnpm screenshots:review`.
 */
describe("suite screenshots", () => {
  /** Drift findings across all captures, asserted empty at the end so one
   * run surfaces every drifted screen (and leaves its diff artifacts),
   * not just the first. */
  const drift: string[] = [];

  /** Hydration + image settle, then a compared capture. The pinned clock
   * (freezePageClock) keeps client-rendered dates stable across runs. */
  async function capture(
    page: import("playwright").Page,
    path: string,
    name: string,
  ): Promise<void> {
    await page.goto(path, { waitUntil: "load", timeout: 15_000 });
    await page.waitForFunction(() => "__reactRouterContext" in window);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("img")].every((img) => img.complete),
    );
    // Post-mount rendering: <LocalDate> swaps ISO for local format, the
    // dashboard computes future badges after hydration.
    try {
      await expect(page).toMatchScreenshot({ name, fullPage: true });
    } catch (error) {
      drift.push(`${name}: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  it("captures the important screens into screenshots/", async () => {
    // Stale .new/.diff artifacts from earlier failed runs would otherwise
    // pile up; baselines themselves are never touched here.
    await removeDiffImages();

    // The globalSetup server is usually already listening on 5199; reuse it
    // rather than spawning a second instance.
    let baseURL = "http://127.0.0.1:5199";
    let launched = false;
    try {
      await fetch(`${baseURL}/login`, { signal: AbortSignal.timeout(3_000) });
    } catch {
      baseURL = await launchServer();
      launched = true;
    }

    try {
      // Logged-out surfaces.
      const fresh = await freshPage({ viewport: { width: 1280, height: 800 } });
      await capture(fresh, "/", "landing");
      await capture(fresh, "/login", "login");
      await capture(fresh, "/onboarding", "onboarding");
      await fresh.close();

      // Signed-in surfaces on the shared (test-credential) session.
      const page = await goto("/");
      await capture(page, "/", "home");
      await capture(page, "/expense/new", "expense-new");

      // The editor needs a real expense row; the global seed provides one,
      // but a test that ran earlier may have deleted them.
      let editor = await testPrisma.expense.findFirst({
        where: { accountId: TEST_ACCOUNT_ID },
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
            category: "Office Supplies",
            description: "",
            amount: 42.5,
            merchant: "Screenshot Fallback",
            imageFile: "",
            imageMime: "image/jpeg",
            originalName: "fallback.jpg",
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
    if (drift.length > 0) {
      throw new Error(
        `${drift.length} screenshot(s) differ from baseline:\n` +
          drift.join("\n"),
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
          quotedOriginal:
            "HARRIS RESTAURANT\n2026-08-30 19:42\nTable 12\n1x Duck Confit 54.00\n1x Glass of wine 12.50\nTip 17.70\nTotal $84.20",
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

    const page = await freshPage({ viewport: { width: 720, height: 900 } });
    try {
      for (const [name, html] of emails) {
        await page.setContent(html, { waitUntil: "load" });
        await expect(page).toMatchScreenshot({
          name: `emails/${name}`,
          fullPage: true,
        });
      }
    } finally {
      await page.close();
      await closeBrowser();
    }
  }, 60_000);
});
