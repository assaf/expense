import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import PDFDocument from "pdfkit";
import { ulid } from "ulid";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";
import { imageVersion } from "~/lib/image-version";
import { saveImage } from "~/lib/images.server";

/** Local-date string (YYYY-MM-DD) — matches the app's `todayDate()`. */
function todayLocal(): string {
  const now = new Date();
  const tz = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - tz).toISOString().slice(0, 10);
}

/** A tiny valid PNG for the receipt-upload tests. */
async function tinyPng(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: {
      width: 120,
      height: 60,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    },
  })
    .png()
    .toBuffer();
}

/** A tiny multi-page LETTER PDF with a real text layer (pdfkit). */
function tinyPdf(pages = 1): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ size: "LETTER" });
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    for (let i = 1; i <= pages; i++) {
      doc.fontSize(12).text(`MERCHANT: Pdf Test ${i}\nTOTAL: ${i}0.00`);
      if (i < pages) doc.addPage();
    }
    doc.end();
  });
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Wait for React Router to settle the create-editor navigation. The router
 * renders the route element once the URL changes, then remounts it ~1ms
 * later when the loader settles — replacing the file input in between. A
 * file set in that window lands on the instance that is about to be torn
 * down and the change event is silently lost (no request ever fires). The
 * remount is tied to React's render cycle, so a short settle beat after
 * waitForURL lands well past it.
 */
async function waitForEditorSettle(page: Page): Promise<void> {
  await page.waitForTimeout(100);
}

/** True when the stored bytes start with the given magic sequence. */
function startsWithMagic(data: Uint8Array, magic: Buffer): boolean {
  const head = Buffer.from(data).subarray(0, magic.length);
  return head.equals(magic);
}

describe("Expense CRUD", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/");
  });

  it("opens the new receipt editor without writing a row", async () => {
    const before = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    // Click "Add receipt"
    await page.getByText("Add receipt").click();
    await page.waitForURL(/\/expense\/new$/, { timeout: 10_000 });
    // The editor is a draft — nothing is persisted until Save.
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(before);
    // A new receipt always starts with today's date.
    await expect(page.getByLabel("Date")).toHaveValue(todayLocal());
    // Should be on the receipt editor (title is "New receipt" if merchant empty)
    await expect(page.locator("h1")).toBeVisible();
    // Amount should be focused on open
    await expect(page.locator("input[type='number']")).toBeFocused();
  });

  it("fills and saves a receipt expense", async () => {
    const before = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    // Fill merchant
    const merchantInput = page.locator("input[list='merchants']");
    await merchantInput.fill("Test Merchant");
    // Fill amount
    const amountInput = page.locator("input[type='number']");
    await amountInput.fill("123.45");
    // Select report
    await page.locator("select").first().selectOption("2026 Test");
    // Select category
    const selects = page.locator("select");
    await selects.nth(1).selectOption("Testing");
    // Submit — only now is the row written.
    await page.getByText("Save").click();
    // Should redirect to home page (with ?new=<id> to highlight the row)
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: 10_000,
    });
    // The new expense should appear in the list
    await expect(page.getByText("Test Merchant")).toBeVisible();
    // The just-added expense is highlighted on arrival (the ring lives on
    // the row container, which wraps the link and any duplicate strip).
    const newRow = page.locator("li").filter({ hasText: "Test Merchant" });
    await expect(newRow.locator(":scope > div")).toHaveClass(/ring-blue-400/);
    // The highlight clears itself after three seconds.
    await expect
      .poll(() => newRow.locator(":scope > div").getAttribute("class"), {
        timeout: 10_000,
      })
      .not.toContain("ring-blue-400");
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(before + 1);
  });

  it("shows the new expense in the list and opens it", async () => {
    await page.goto("/", { waitUntil: "load" });
    await expect(page.getByText("Test Merchant")).toBeVisible();
    // Click on it to open the editor
    await page.getByText("Test Merchant").click();
    await page.waitForURL(/\/expense\//, { timeout: 10_000 });
    // The merchant should be pre-filled
    await expect(page.locator("input[list='merchants']")).toHaveValue(
      "Test Merchant",
    );
  });

  it("edits an existing receipt and saves the changes", async () => {
    // Create a receipt to edit.
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add receipt").click();
    await page.waitForURL(/\/expense\/new$/, { timeout: 10_000 });
    await page.locator("input[list='merchants']").fill("Edit Target");
    await page.locator("input[type='number']").fill("5.00");
    await page.locator("select").first().selectOption("2026 Test");
    const selects = page.locator("select");
    await selects.nth(1).selectOption("Testing");
    await page.getByText("Save").click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });

    // Reopen it and change every field.
    await page.getByText("Edit Target").click();
    await page.waitForURL(/\/expense\//, { timeout: 10_000 });
    const merchantInput = page.locator("input[list='merchants']");
    await merchantInput.fill("Edited Merchant");
    await page.locator("input[type='number']").fill("99.99");
    await page.locator("select").first().selectOption("2027 Test");
    const editSelects = page.locator("select");
    await editSelects.nth(1).selectOption("Development");
    await page.getByText("Save").click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });

    // The updated values appear in the list; the old ones are gone.
    await expect(page.getByText("Edited Merchant")).toBeVisible();
    await expect(page.getByText("Edit Target")).toHaveCount(0);

    // The database reflects the update, not a delete + insert.
    const row = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, merchant: "Edited Merchant" },
    });
    expect(row).not.toBeNull();
    // Prisma returns amount as a Decimal — compare as strings.
    expect(String(row!.amount)).toBe("99.99");
    expect(row!.report).toBe("2027 Test");
    expect(row!.category).toBe("Development");

    // Clean up.
    await testPrisma.expense.delete({ where: { id: row!.id } });
  });

  it("deletes an expense", async () => {
    const before = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    // Navigate to the expense we created
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Test Merchant").click();
    await page.waitForURL(/\/expense\//, { timeout: 10_000 });
    // Click delete
    await page.getByText("Delete").click();
    // Confirm dialog
    await page.getByText("Delete").last().click();
    // Should redirect to home
    await page.waitForURL("/", { timeout: 10_000 });
    // The expense should no longer be in the list
    await expect(page.getByText("Test Merchant")).not.toBeVisible();
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(before - 1);
  });

  it("uploads a draft receipt image and attaches it on save", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add receipt").click();
    await page.waitForURL(/\/expense\/new$/, { timeout: 10_000 });
    await waitForEditorSettle(page);

    const before = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    const blobsBefore = await testPrisma.imageBlob.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });

    // Attaching an image stores a draft blob but writes no expense row. The
    // draft-upload response is gated on OCR, so wait for it before saving.
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/expense") && r.request().method() === "POST",
        { timeout: 30_000 },
      ),
      page.locator('input[type="file"]').setInputFiles({
        name: "receipt.png",
        mimeType: "image/png",
        buffer: await tinyPng(),
      }),
    ]);
    expect(resp.ok()).toBeTruthy();
    expect(
      await testPrisma.imageBlob.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(blobsBefore + 1);
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(before);

    // Save creates the row with the draft image attached.
    await page.getByText("Save").click();
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: 15_000,
    });
    const created = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, imageFile: true },
    });
    expect(created?.imageFile).not.toBe("");

    // Leave the database as we found it.
    if (created) {
      await testPrisma.expense.delete({ where: { id: created.id } });
      await testPrisma.imageBlob.deleteMany({
        where: { accountId: TEST_ACCOUNT_ID, key: created.imageFile },
      });
    }
  });

  it("uploads a PDF draft, rasterizes it to a stored PNG/JPEG, and saves", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add receipt").click();
    await page.waitForURL(/\/expense\/new$/, { timeout: 10_000 });
    await waitForEditorSettle(page);

    const before = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    const blobsBefore = await testPrisma.imageBlob.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });

    // The editor then runs a second POST (draft-ocr) to fill in the fields —
    // count responses so the assertion is race-free.
    let posts = 0;
    let ocrOk: boolean | undefined;
    page.on("response", (r) => {
      if (r.url().includes("/api/expense") && r.request().method() === "POST") {
        posts += 1;
        if (posts === 2) ocrOk = r.ok();
      }
    });

    // Upload a PDF: the draft-upload response is gated on rasterization
    // only — OCR runs as a separate request (see below) so a slow scan can
    // never block the draft. Two pages give the conversion stage a visible
    // window to assert against.
    const upload = page.waitForResponse(
      (r) =>
        r.url().includes("/api/expense") && r.request().method() === "POST",
      { timeout: 30_000 },
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: "receipt.pdf",
      mimeType: "application/pdf",
      buffer: await tinyPdf(2),
    });
    // The progress indicator shows the stage while the server rasterizes.
    await expect(page.getByText("Converting PDF")).toBeVisible({
      timeout: 10_000,
    });
    const resp = await upload;
    expect(resp.ok()).toBeTruthy();

    // While the second request reads the receipt, the indicator switches to
    // the OCR stage. Assert it before the OCR completes (the poll below
    // resolves when the panel disappears).
    await expect(page.getByText("Reading receipt")).toBeVisible({
      timeout: 30_000,
    });

    // The draft-upload response comes back without OCR fields; the separate
    // draft-ocr POST must still complete (fields may be empty without an AI
    // key — the request itself is the contract).
    await expect.poll(() => posts, { timeout: 60_000 }).toBe(2);
    expect(ocrOk).toBe(true);

    // The draft is stored as rasterized, browser-displayable bytes — never
    // the raw PDF (an <img> can't render one). Draft keys are ULID-prefixed,
    // so the newest upload sorts last by key.
    const draft = await testPrisma.imageBlob.findFirst({
      where: { accountId: TEST_ACCOUNT_ID },
      orderBy: { key: "desc" },
      select: { key: true, mime: true, data: true },
    });
    expect(draft).not.toBeNull();
    expect(draft!.mime).toBe("image/jpeg");
    expect(
      startsWithMagic(draft!.data, JPEG_MAGIC) ||
        startsWithMagic(draft!.data, PNG_MAGIC),
    ).toBe(true);
    // No expense row is written by the upload itself.
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(before);
    expect(
      await testPrisma.imageBlob.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(blobsBefore + 1);

    // The preview is the rasterized draft served from storage, not a PDF blob.
    await expect(page.locator("img").first()).toHaveAttribute(
      "src",
      /\/api\/expense\?draftKey=/,
    );

    // Save attaches the draft and the row appears.
    await page.getByText("Save").click();
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: 15_000,
    });
    const created = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, imageFile: true, imageMime: true },
    });
    expect(created?.imageFile).not.toBe("");
    expect(created?.imageMime).toBe("image/jpeg");
    const stored = await testPrisma.imageBlob.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, key: created!.imageFile },
      select: { data: true },
    });
    expect(stored).not.toBeNull();
    expect(startsWithMagic(stored!.data, JPEG_MAGIC)).toBe(true);

    // Leave the database as we found it.
    if (created) {
      await testPrisma.expense.delete({ where: { id: created.id } });
      await testPrisma.imageBlob.deleteMany({
        where: { accountId: TEST_ACCOUNT_ID, key: created.imageFile },
      });
    }
  });

  it("serves receipt images with nosniff and a sandboxing CSP", async () => {
    // Defense-in-depth on the image route: even if a stored blob ever had a
    // renderable type, the headers must stop it executing in document mode.
    const png = await tinyPng();
    const { filename } = await saveImage(
      TEST_ACCOUNT_ID,
      png,
      "image/png",
      "headers.png",
    );
    const id = ulid();
    const now = new Date().toISOString();
    await testPrisma.expense.create({
      data: {
        id,
        accountId: TEST_ACCOUNT_ID,
        type: "receipt",
        date: "2026-01-15",
        report: "2026 Test",
        category: "Office Supplies",
        description: "",
        amount: "1.00",
        merchant: "Header Test",
        imageFile: filename,
        imageMime: "image/jpeg",
        originalName: "headers.png",
        locations: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    try {
      const res = await page.request.get(`/expense/${id}/image`);
      expect(res.status()).toBe(200);
      const headers = res.headers();
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["content-security-policy"]).toContain("sandbox");
    } finally {
      await testPrisma.expense.deleteMany({ where: { id } });
      await testPrisma.imageBlob.deleteMany({ where: { key: filename } });
    }
  });

  it("caches content-keyed image URLs immutably for a year", async () => {
    const png = await tinyPng();
    const { filename } = await saveImage(
      TEST_ACCOUNT_ID,
      png,
      "image/png",
      "version.png",
    );
    const id = ulid();
    const now = new Date().toISOString();
    await testPrisma.expense.create({
      data: {
        id,
        accountId: TEST_ACCOUNT_ID,
        type: "receipt",
        date: "2026-01-15",
        report: "2026 Test",
        category: "Office Supplies",
        description: "",
        amount: "1.00",
        merchant: "Version Test",
        imageFile: filename,
        imageMime: "image/jpeg",
        originalName: "version.png",
        locations: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    // The version the list/editor render into the URL.
    const version = imageVersion({ updatedAt: now, imageFile: filename });
    const versionedUrl = `/expense/${id}/image?w=160&v=${encodeURIComponent(
      version,
    )}`;
    try {
      const res = await page.request.get(versionedUrl);
      expect(res.status()).toBe(200);
      const headers = res.headers();
      expect(headers["cache-control"]).toContain("max-age=31536000");
      expect(headers["cache-control"]).toContain("immutable");
      expect(headers["etag"]).toBe(`W/"${version}"`);

      // A matching If-None-Match is answered with a bodyless 304.
      const revalidated = await page.request.get(versionedUrl, {
        headers: { "if-none-match": `W/"${version}"` },
      });
      expect(revalidated.status()).toBe(304);

      // A stale/mismatched version (legacy URL, old tab) falls back to the
      // short TTL so the browser revalidates and picks up a replacement.
      const stale = await page.request.get(
        `/expense/${id}/image?w=160&v=stale`,
      );
      expect(stale.status()).toBe(200);
      expect(stale.headers()["cache-control"]).toContain("max-age=86400");
      expect(stale.headers()["cache-control"]).not.toContain("31536000");
    } finally {
      await testPrisma.expense.deleteMany({ where: { id } });
      await testPrisma.imageBlob.deleteMany({ where: { key: filename } });
    }
  });

  it("saves with a future date (invoice dated ahead of payment)", async () => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add receipt").click();
    await page.waitForURL(/\/expense\/new$/, { timeout: 10_000 });

    await page.locator("input[list='merchants']").fill("Future Shop");
    await page.locator("input[type='number']").fill("50.00");
    await page.getByLabel("Date").fill("2099-12-31");
    await page.getByText("Save").click();

    // Future dates are allowed — the save succeeds and returns to the list.
    await expect(page).toHaveURL(/\/$/);
    const row = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, merchant: "Future Shop" },
    });
    expect(row?.date).toBe("2099-12-31");
    // The list flags future-dated expenses so they don't read as normal
    // rows — a "Future" pill next to the date.
    await expect(page.getByText("Future").first()).toBeVisible();
    await testPrisma.expense.deleteMany({
      where: { accountId: TEST_ACCOUNT_ID, merchant: "Future Shop" },
    });
  });

  it("drags a file onto the home page to create a receipt draft", async () => {
    await page.goto("/", { waitUntil: "load" });

    // Dropping an unsupported file does nothing — no navigation.
    const textDrop = await page.evaluateHandle(() => new DataTransfer());
    await textDrop.evaluate((dt) => {
      dt.items.add(new File(["hello"], "note.txt", { type: "text/plain" }));
    });
    await page.locator("main").dispatchEvent("drop", {
      dataTransfer: textDrop,
    });
    await expect(page).toHaveURL("/");

    const blobsBefore = await testPrisma.imageBlob.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    const expensesBefore = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });

    // Dropping a receipt image opens the editor and uploads it as a draft.
    const png = await tinyPng();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await dataTransfer.evaluate(
      (dt, bytes) => {
        dt.items.add(
          new File([new Uint8Array(bytes)], "drop.png", { type: "image/png" }),
        );
      },
      [...png],
    );
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/expense") && r.request().method() === "POST",
        { timeout: 30_000 },
      ),
      page.locator("main").dispatchEvent("drop", { dataTransfer }),
    ]);
    await page.waitForURL(/\/expense\/new$/, { timeout: 10_000 });
    expect(resp.ok()).toBeTruthy();
    expect(
      await testPrisma.imageBlob.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(blobsBefore + 1);
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(expensesBefore);
    // The draft preview is the image rendered from the blob URL.
    await expect(page.locator("img").first()).toHaveAttribute("src", /^blob:/);

    // Leave the database as we found it (the draft is never saved).
    const draft = await testPrisma.imageBlob.findFirst({
      where: { accountId: TEST_ACCOUNT_ID },
      orderBy: { key: "desc" },
      select: { key: true },
    });
    if (draft) {
      await testPrisma.imageBlob.deleteMany({
        where: { accountId: TEST_ACCOUNT_ID, key: draft.key },
      });
    }
  });

  it("drags a receipt onto the editor: dashed outline, then upload + re-read", async () => {
    const expense = await testPrisma.expense.findFirstOrThrow({
      where: { accountId: TEST_ACCOUNT_ID, merchant: "Test Store" },
    });
    await page.goto(`/expense/${expense.id}`, { waitUntil: "load" });
    const main = page.locator("main#main-content");

    // The seeded expense has every data field — no image — and the notice
    // is down (the image is not a completeness factor).
    await expect(page.getByText("Incomplete")).toHaveCount(0);

    // Dragging over the page highlights the drop target with a dashed
    // outline and announces it to screen readers.
    const drag = await page.evaluateHandle(() => new DataTransfer());
    await main.dispatchEvent("dragenter", { dataTransfer: drag });
    await expect(main).toHaveClass(/outline-dashed/);
    await expect(
      page.locator('.sr-only[role="status"][aria-live="polite"]'),
    ).toContainText("Receipt file detected");

    // Leaving clears the highlight.
    await main.dispatchEvent("dragleave", { dataTransfer: drag });
    await expect(main).not.toHaveClass(/outline-dashed/);

    // Dropping a receipt image replaces the image (one POST to the image
    // route) and re-reads the fields (one POST to /api/expense).
    const png = await tinyPng();
    const drop = await page.evaluateHandle(() => new DataTransfer());
    await drop.evaluate(
      (dt, bytes) => {
        dt.items.add(
          new File([new Uint8Array(bytes)], "drop.png", { type: "image/png" }),
        );
      },
      [...png],
    );
    const replace = page.waitForResponse(
      (r) =>
        r.url().includes(`/expense/${expense.id}/image`) &&
        r.request().method() === "POST",
      { timeout: 30_000 },
    );
    const ocr = page.waitForResponse(
      (r) =>
        r.url().includes("/api/expense") && r.request().method() === "POST",
      { timeout: 30_000 },
    );
    await main.dispatchEvent("drop", { dataTransfer: drop });
    expect((await replace).ok()).toBeTruthy();
    expect((await ocr).ok()).toBeTruthy();

    // The image is stored and attached to the expense row.
    await expect
      .poll(
        async () =>
          (
            await testPrisma.expense.findUniqueOrThrow({
              where: { id: expense.id },
            })
          ).imageFile,
        { timeout: 15_000 },
      )
      .not.toBe("");
    await expect(page.locator("img")).toBeVisible();
    // All data fields are present before and after the drop — the notice
    // stays down.
    await expect(page.getByText("Incomplete")).toHaveCount(0);

    // Leave the database as we found it.
    const stored = (
      await testPrisma.expense.findUniqueOrThrow({ where: { id: expense.id } })
    ).imageFile;
    if (stored) {
      await testPrisma.imageBlob.deleteMany({
        where: { accountId: TEST_ACCOUNT_ID, key: stored },
      });
      await testPrisma.expense.update({
        where: { id: expense.id },
        data: { imageFile: "", imageMime: "", originalName: "" },
      });
    }
  });

  it("shows the Incomplete notice only while editing, not when creating", async () => {
    // Create mode: a fresh expense is expected to be missing fields — the
    // badge is reserved for editing, where it flags what to fill in.
    await page.goto("/expense/new", { waitUntil: "load" });
    await expect(page.getByText("Incomplete")).toHaveCount(0);

    // Edit mode on an incomplete expense: the badge tells you what to fill.
    const id = ulid();
    const now = new Date().toISOString();
    await testPrisma.expense.create({
      data: {
        id,
        accountId: TEST_ACCOUNT_ID,
        type: "receipt",
        date: "2026-07-15",
        report: "",
        category: "",
        description: "",
        amount: null,
        merchant: "",
        imageFile: "",
        imageMime: "",
        originalName: "",
        locations: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    try {
      await page.goto(`/expense/${id}`, { waitUntil: "load" });
      await expect(page.getByText("Incomplete")).toBeVisible();

      // Filling the data fields clears the notice — the receipt image is
      // not a completeness factor, so no draft upload is needed.
      await page.getByLabel("Amount").fill("12.34");
      await page.locator("input[list='merchants']").fill("Drag Test Store");
      await page.getByLabel("Category").selectOption({ label: "Testing" });
      await page.getByLabel("Report").selectOption({ label: "2026 Test" });
      await expect(page.getByText("Incomplete")).toHaveCount(0);

      // Emptying a field brings the notice back (still editing).
      await page.getByLabel("Amount").fill("");
      await expect(page.getByText("Incomplete")).toBeVisible();
    } finally {
      await testPrisma.expense.deleteMany({ where: { id } });
    }
  });

  afterAll(async () => {
    await page?.close();
  });
});
