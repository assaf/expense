import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

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
    await expect(page.locator("input[type='date']")).toHaveValue(todayLocal());
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
    // Should redirect to home page
    await page.waitForURL("/", { timeout: 10_000 });
    // The new expense should appear in the list
    await expect(page.getByText("Test Merchant")).toBeVisible();
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
    await page.waitForURL("/", { timeout: 15_000 });
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

  afterAll(async () => {
    await page?.close();
  });
});
