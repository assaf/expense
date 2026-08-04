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
      page.getByRole("heading", { name: "Start/end location" }),
    ).toBeVisible();
  });

  it("shows the account invite code", async () => {
    await expect(page.getByText("TESTCODE1")).toBeVisible();
  });

  it("displays the seeded reports", async () => {
    await expect(page.getByText("2026 Test")).toBeVisible();
    await expect(page.getByText("2027 Test")).toBeVisible();
  });

  it("shows the sign-in email as a pending receipts-by-email sender", async () => {
    // The login email is auto-added as the account's default sender on
    // sign-in — pending until its verification link is clicked.
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Receipts by email" }),
    });
    await expect(section.getByText("testuser@example.com")).toBeVisible();
    await expect(section.getByText("Your sign-in email")).toBeVisible();
    await expect(section.getByText("Awaiting verification")).toBeVisible();
    // The default sender row can't be removed.
    await expect(
      section.getByRole("button", { name: /Remove testuser@example.com/ }),
    ).toHaveCount(0);
  });

  it("adds a sender as pending and reports the verification email", async () => {
    const page = await goto("/settings");
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Receipts by email" }),
    });
    await section
      .locator('input[type="email"][name="address"]')
      .fill("extra@example.com");
    await section.getByRole("button", { name: "Add address" }).click();
    await expect(
      section.getByText("extra@example.com", { exact: true }),
    ).toBeVisible();
    await expect(section.getByText("Awaiting verification")).toHaveCount(2);
    await expect(
      section.getByText(/Verification email sent to extra@example.com/),
    ).toBeVisible();
    await page.close();
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

  it("shows an error when adding a duplicate category", async () => {
    const page = await goto("/settings");
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    await section.locator('input[type="text"][name="name"]').fill("Testing");
    await section.getByRole("button", { name: "Add" }).click();
    // Duplicate — the action reports it inline; the existing row doesn't
    // flash and the input keeps the typed value so the user can correct it.
    await expect(section.getByText(/already exists/i)).toBeVisible();
    const existing = section.locator("ul li").filter({ hasText: "Testing" });
    await expect(existing).not.toHaveClass(/bg-amber-200/);
    await expect(
      section.locator('input[type="text"][name="name"]'),
    ).toHaveValue("Testing");
    // Typing clears the error.
    await section.locator('input[type="text"][name="name"]').fill("New Name");
    await expect(section.getByText(/already exists/i)).toHaveCount(0);
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

  it("renames a category and updates its expenses", async () => {
    // Seed a category plus one unassigned expense using it, then rename
    // through the UI and check the expense's reference followed.
    const now = new Date().toISOString();
    await testPrisma.category.createMany({
      data: [{ name: "Temp Category", accountId: TEST_ACCOUNT_ID }],
      skipDuplicates: true,
    });
    await testPrisma.expense.createMany({
      data: [
        {
          id: "exp_renamecat1",
          type: "receipt",
          date: "2026-01-01",
          report: "",
          category: "Temp Category",
          description: "",
          amount: "5.00",
          merchant: "Rename Shop",
          imageFile: "",
          imageMime: "",
          originalName: "",
          distanceMiles: null,
          locations: [],
          createdAt: now,
          updatedAt: now,
          accountId: TEST_ACCOUNT_ID,
        },
      ],
    });

    const page = await goto("/settings");
    const categories = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    const row = categories
      .locator("ul li")
      .filter({ hasText: "Temp Category" });
    // Renames happen in place: no navigation, no page jump. Pin the scroll
    // position before renaming and check it's untouched afterwards.
    await page.evaluate(() => window.scrollTo(0, 400));
    await row.scrollIntoViewIfNeeded();
    const scrollY = await page.evaluate(() => window.scrollY);
    await row.getByRole("button", { name: /rename temp category/i }).click();
    // The row is now an editor (input + Save/Cancel) — locate it via the
    // section, since the row's text no longer contains the old name.
    const input = categories.locator('input[name="newName"]');
    await expect(input).toBeVisible();
    await input.fill("Temp Category 2");
    await categories.getByRole("button", { name: "Save" }).click();

    await expect(
      categories.locator("ul li").filter({ hasText: "Temp Category 2" }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    // The expense's category reference moved with the rename.
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID, category: "Temp Category 2" },
      }),
    ).toBe(1);
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID, category: "Temp Category" },
      }),
    ).toBe(0);
    await page.close();
  });

  it("renames a report and updates its expenses and mileage", async () => {
    // Seed a report with one receipt and one mileage expense (plus its
    // derived mileage row), rename it, and check every reference moved.
    const now = new Date().toISOString();
    await testPrisma.report.createMany({
      data: [{ name: "Draft Q3", accountId: TEST_ACCOUNT_ID }],
      skipDuplicates: true,
    });
    await testPrisma.expense.createMany({
      data: [
        {
          id: "exp_renamerep1",
          type: "receipt",
          date: "2026-02-01",
          report: "Draft Q3",
          category: "Testing",
          description: "",
          amount: "7.00",
          merchant: "R Shop",
          imageFile: "",
          imageMime: "",
          originalName: "",
          distanceMiles: null,
          locations: [],
          createdAt: now,
          updatedAt: now,
          accountId: TEST_ACCOUNT_ID,
        },
        {
          id: "exp_renamerep2",
          type: "mileage",
          date: "2026-02-02",
          report: "Draft Q3",
          category: "Testing",
          description: "",
          amount: "3.00",
          merchant: "",
          imageFile: "",
          imageMime: "",
          originalName: "",
          distanceMiles: "5.00",
          locations: [{ address: "A", lat: null, lng: null }],
          createdAt: now,
          updatedAt: now,
          accountId: TEST_ACCOUNT_ID,
        },
      ],
    });
    await testPrisma.mileage.createMany({
      data: [
        {
          date: "2026-02-02",
          report: "Draft Q3",
          locations: "A",
          distanceMiles: "5.00",
          accountId: TEST_ACCOUNT_ID,
        },
      ],
    });

    const page = await goto("/settings");
    const reports = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Reports" }),
    });
    const row = reports.locator("ul li").filter({ hasText: "Draft Q3" });
    await row.getByRole("button", { name: /rename draft q3/i }).click();
    await reports.locator('input[name="newName"]').fill("Final Q3");
    await reports.getByRole("button", { name: "Save" }).click();

    await expect(
      reports.locator("ul li").filter({ hasText: "Final Q3" }),
    ).toBeVisible();
    expect(
      await testPrisma.report.count({
        where: { accountId: TEST_ACCOUNT_ID, name: "Final Q3" },
      }),
    ).toBe(1);
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID, report: "Final Q3" },
      }),
    ).toBe(2);
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID, report: "Draft Q3" },
      }),
    ).toBe(0);
    expect(
      await testPrisma.mileage.count({
        where: { accountId: TEST_ACCOUNT_ID, report: "Final Q3" },
      }),
    ).toBe(1);
    await page.close();
  });

  it("does not rename a category to an existing name", async () => {
    // Seed two categories; renaming one onto the other must be a no-op that
    // leaves the editor open (rows only remount on a successful rename).
    await testPrisma.category.createMany({
      data: [
        { name: "Temp Category 3", accountId: TEST_ACCOUNT_ID },
        { name: "Temp Dupe", accountId: TEST_ACCOUNT_ID },
      ],
      skipDuplicates: true,
    });

    const page = await goto("/settings");
    const categories = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    const row = categories
      .locator("ul li")
      .filter({ hasText: "Temp Category 3" });
    await row.getByRole("button", { name: /rename temp category 3/i }).click();
    await categories.locator('input[name="newName"]').fill("Temp Dupe");
    await categories.getByRole("button", { name: "Save" }).click();

    // The action reports the duplicate inline, and the editor stays open so
    // the user can fix the name.
    await expect(categories.getByText(/already exists/i)).toBeVisible();
    await expect(categories.locator('input[name="newName"]')).toBeVisible();
    await categories.getByRole("button", { name: "Cancel" }).click();
    await expect(
      categories.locator("ul li").filter({ hasText: "Temp Category 3" }),
    ).toBeVisible();
    expect(
      await testPrisma.category.count({
        where: { accountId: TEST_ACCOUNT_ID, name: "Temp Dupe" },
      }),
    ).toBe(1);
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
          distanceMiles: null,
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
