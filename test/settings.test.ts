import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

// `page` is shared read-only across the display tests; the mutation tests
// drive their own page. Tests that delete reports run last — deleting a
// report cascades to its expenses, which would skew the category counts the
// earlier tests assert.
describe("Settings", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/settings");
  });

  it("shows the settings page", async () => {
    await expect(page.locator("h1")).toContainText("Settings");
  });

  it("shows reports, categories, mileage rates, and home fields", async () => {
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Categories" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Mileage rates" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Home location" }),
    ).toBeVisible();
  });

  it("shows the account invite code", async () => {
    await expect(page.getByText("TESTCODE1")).toBeVisible();
  });

  it("displays the seeded reports", async () => {
    await expect(page.getByText("2026 Test")).toBeVisible();
    await expect(page.getByText("2027 Test")).toBeVisible();
  });

  it("lists reports chronologically and categories alphabetically", async () => {
    const reports = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Reports" }),
    });
    const categories = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    // Reports render in creation order (oldest first) with their status
    // badge and expense count; categories are sorted alphabetically
    // regardless of when they were created.
    await expect(reports.locator("ul li")).toHaveText([
      "2026 TestOpen4 expensesClose",
      "2027 TestOpen1 expenseClose",
    ]);
    await expect(categories.locator("ul li")).toHaveText([
      "Development2 expenses",
      "Office Supplies1 expense",
      "Testing3 expenses",
    ]);
  });

  it("shows each report's status and expense count", async () => {
    const page = await goto("/settings");
    const reports = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Reports" }),
    });
    const first = reports.locator("ul li").filter({ hasText: "2026 Test" });
    await expect(first.getByText("Open", { exact: true })).toBeVisible();
    await expect(first.getByText("4 expenses")).toBeVisible();
    const second = reports.locator("ul li").filter({ hasText: "2027 Test" });
    await expect(second.getByText("Open", { exact: true })).toBeVisible();
    await expect(second.getByText("1 expense")).toBeVisible();
    await page.close();
  });

  it("closes and reopens a report", async () => {
    const page = await goto("/settings");
    const reports = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Reports" }),
    });
    const row = reports.locator("ul li").filter({ hasText: "2027 Test" });

    await row.getByRole("button", { name: "Close" }).click();
    await expect(row.getByText("Closed")).toBeVisible();
    await expect(row.getByRole("button", { name: "Reopen" })).toBeVisible();
    // Expense count is untouched by closing.
    await expect(row.getByText("1 expense")).toBeVisible();

    await row.getByRole("button", { name: "Reopen" }).click();
    // Exact match — "Open" must not match the "Reopen" button's own text,
    // and the Close button only exists once the reopen navigation settles.
    await expect(row.getByText("Open", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Close" })).toBeVisible();
    await page.close();
  });

  it("adds a category, flashes it for 3s, and clears the input", async () => {
    const page = await goto("/settings");
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    const rows = section.locator("ul li");

    await section
      .locator('input[type="text"][name="name"]')
      .fill("New Category");
    await section.getByRole("button", { name: "Add" }).click();

    // The new entry lands in its alphabetical slot, flashed, input cleared.
    await expect(rows).toHaveText([
      "Development2 expenses",
      "New CategoryNo expenses",
      "Office Supplies1 expense",
      "Testing3 expenses",
    ]);
    const newRow = rows.filter({ hasText: "New Category" });
    await expect(newRow).toHaveClass(/bg-amber-200/);
    // The input field is empty after the reload.
    await expect(
      section.locator('input[type="text"][name="name"]'),
    ).toHaveValue("");

    // The highlight fades out after ~3 seconds.
    await expect(newRow).not.toHaveClass(/bg-amber-200/, { timeout: 5_000 });
    await page.close();
  });

  it("does not flash when the added category already exists", async () => {
    const page = await goto("/settings");
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    await section.locator('input[type="text"][name="name"]').fill("Testing");
    await section.getByRole("button", { name: "Add" }).click();
    // Duplicate — no flash URL, no highlight on the existing row.
    await expect(page).not.toHaveURL(/addedCategory=/);
    const existing = section.locator("ul li").filter({ hasText: "Testing" });
    await expect(existing).not.toHaveClass(/bg-amber-200/);
    await page.close();
  });

  it("category counts exclude expenses in closed reports", async () => {
    const page = await goto("/settings");
    const categories = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    const devRow = categories
      .locator("ul li")
      .filter({ hasText: "Development" });
    await expect(devRow.getByText("2 expenses")).toBeVisible();

    // Close "2027 Test" — one of Development's expenses lives in it.
    const reports = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Reports" }),
    });
    const reportRow = reports.locator("ul li").filter({ hasText: "2027 Test" });
    await reportRow.getByRole("button", { name: "Close" }).click();
    await expect(reportRow.getByText("Closed")).toBeVisible();

    // The category count drops for the newly closed report…
    await expect(devRow.getByText("1 expense")).toBeVisible();
    // …and comes back once the report is reopened.
    await reportRow.getByRole("button", { name: "Reopen" }).click();
    await expect(devRow.getByText("2 expenses")).toBeVisible();
    await page.close();
  });

  it("deletes a category with one expense without confirmation", async () => {
    const page = await goto("/settings");
    const categories = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    const row = categories
      .locator("ul li")
      .filter({ hasText: "Office Supplies" });

    let dialogShown = false;
    page.on("dialog", () => {
      dialogShown = true;
    });
    await row.getByRole("button", { name: /remove office supplies/i }).click();
    await expect(row).toHaveCount(0);
    expect(dialogShown).toBe(false);
    await page.close();
  });

  it("asks before deleting a category with several expenses", async () => {
    const page = await goto("/settings");
    const categories = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    const row = categories.locator("ul li").filter({ hasText: "Development" });

    // Dismiss the confirmation — nothing is deleted.
    page.once("dialog", (d) => void d.dismiss());
    await row.getByRole("button", { name: /remove development/i }).click();
    await expect(row).toBeVisible();

    // Accept the confirmation — the category is deleted, its expenses stay.
    let message = "";
    page.once("dialog", (d) => {
      message = d.message();
      void d.accept();
    });
    await row.getByRole("button", { name: /remove development/i }).click();
    expect(message).toContain("2 expenses");
    await expect(row).toHaveCount(0);
    // Categories don't cascade: the expenses keep their category reference.
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID, category: "Development" },
      }),
    ).toBe(2);
    await page.close();
  });

  // --- Report deletion (cascades to expenses) — runs last on purpose. ------

  it("deletes an open report with one expense without confirmation", async () => {
    const page = await goto("/settings");
    const reports = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Reports" }),
    });
    const section = reports;
    await section
      .locator('input[type="text"][name="name"]')
      .fill("Temp Report");
    await section.getByRole("button", { name: "Add" }).click();
    const row = section.locator("ul li").filter({ hasText: "Temp Report" });
    await expect(row).toBeVisible();

    let dialogShown = false;
    page.on("dialog", () => {
      dialogShown = true;
    });
    await row.getByRole("button", { name: /remove temp report/i }).click();
    await expect(row).toHaveCount(0);
    expect(dialogShown).toBe(false);
    await page.close();
  });

  it("asks before deleting a report with several expenses", async () => {
    const page = await goto("/settings");
    const reports = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Reports" }),
    });
    const row = reports.locator("ul li").filter({ hasText: "2026 Test" });

    // Dismiss the confirmation — nothing is deleted.
    page.once("dialog", (d) => void d.dismiss());
    await row.getByRole("button", { name: /remove 2026 test/i }).click();
    await expect(row).toBeVisible();

    // Accept the confirmation — the report and all its expenses are deleted.
    let message = "";
    page.once("dialog", (d) => {
      message = d.message();
      void d.accept();
    });
    await row.getByRole("button", { name: /remove 2026 test/i }).click();
    expect(message).toContain("4 expenses");
    await expect(row).toHaveCount(0);
    // Cascade: every expense (and derived mileage row) of the report is gone.
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID, report: "2026 Test" },
      }),
    ).toBe(0);
    expect(
      await testPrisma.mileage.count({
        where: { accountId: TEST_ACCOUNT_ID, report: "2026 Test" },
      }),
    ).toBe(0);
    await page.close();
  });

  it("asks before deleting a closed report", async () => {
    const page = await goto("/settings");
    const reports = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Reports" }),
    });
    const row = reports.locator("ul li").filter({ hasText: "2027 Test" });

    // Close it first, then try to delete it. Reopen first if an earlier
    // test left it closed, so this test doesn't depend on test order.
    if ((await row.getByRole("button", { name: "Close" }).count()) === 0) {
      await row.getByRole("button", { name: "Reopen" }).click();
      await expect(row.getByText("Open", { exact: true })).toBeVisible();
    }
    await row.getByRole("button", { name: "Close" }).click();
    await expect(row.getByText("Closed")).toBeVisible();

    let message = "";
    page.once("dialog", (d) => {
      message = d.message();
      void d.accept();
    });
    await row.getByRole("button", { name: /remove 2027 test/i }).click();
    expect(message).toContain("closed");
    await expect(row).toHaveCount(0);
    // Cascade: the single expense in the report is gone too.
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID, report: "2027 Test" },
      }),
    ).toBe(0);
    await page.close();
  });

  it("deleting a report deletes its receipt images", async () => {
    // Seed a report with one receipt that has a stored image blob, then
    // delete the report through the UI and check the image is cleaned up.
    const key = "2026-01-01_Image Test.png";
    const now = new Date().toISOString();
    await testPrisma.report.createMany({
      data: [{ name: "Image Test", accountId: TEST_ACCOUNT_ID }],
      skipDuplicates: true,
    });
    await testPrisma.imageBlob.create({
      data: {
        accountId: TEST_ACCOUNT_ID,
        key,
        mime: "image/png",
        data: Buffer.from("fake-receipt-bytes"),
      },
    });
    await testPrisma.expense.createMany({
      data: [
        {
          id: "exp_imgtest1",
          type: "receipt",
          date: "2026-01-01",
          report: "Image Test",
          category: "Testing",
          description: "",
          amount: "10.00",
          merchant: "Photo Shop",
          imageFile: key,
          imageMime: "image/png",
          originalName: "receipt.png",
          distanceMiles: "",
          locations: [],
          createdAt: now,
          updatedAt: now,
          accountId: TEST_ACCOUNT_ID,
        },
      ],
    });

    const page = await goto("/settings");
    const reports = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Reports" }),
    });
    const row = reports.locator("ul li").filter({ hasText: "Image Test" });
    // One open expense — no confirmation needed.
    await row.getByRole("button", { name: /remove image test/i }).click();
    await expect(row).toHaveCount(0);

    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID, report: "Image Test" },
      }),
    ).toBe(0);
    expect(
      await testPrisma.imageBlob.count({
        where: { accountId: TEST_ACCOUNT_ID, key },
      }),
    ).toBe(0);
    await page.close();
  });

  afterAll(async () => {
    await page?.close();
  });
});
