import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

// `page` is shared read-only across the display tests; the mutation tests
// drive their own page. Tests that delete reports run last, because deleting a
// report cascades to its expenses, which would skew the category counts the
// earlier tests assert.
describe("Settings", () => {
  let page: Page;

  beforeAll(async () => {
    // Two extra members in the test account: one who verified their email
    // ("Active") and one who joined but hasn't clicked the link yet
    // ("Waiting to verify"). Seeded before the page loads so the members
    // list shows them.
    await testPrisma.user.createMany({
      data: [
        {
          id: "user_member_verified",
          accountId: TEST_ACCOUNT_ID,
          email: "verified.member@example.com",
          passwordHash: "x",
          emailVerifiedAt: "2026-07-02T00:00:00.000Z",
          createdAt: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "user_member_pending",
          accountId: TEST_ACCOUNT_ID,
          email: "pending.member@example.com",
          passwordHash: "x",
          emailVerifiedAt: null,
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      ],
    });
    page = await goto("/settings");
  });

  it("shows the settings page", async () => {
    await expect(page.locator("h1")).toContainText("Settings");
  });

  it("shows categories, mileage rates, and home fields", async () => {
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

  it("lists account members with their verification status", async () => {
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Account" }),
    });
    // The signed-in user, pinned first with a "You" badge.
    await expect(section.getByText("testuser@example.com")).toBeVisible();
    await expect(section.getByText("You", { exact: true })).toBeVisible();
    // A member who clicked the emailed verification link is Active; the
    // signed-in user is verified too, so exactly two Active badges.
    await expect(
      section.getByText("verified.member@example.com"),
    ).toBeVisible();
    await expect(section.getByText("Active", { exact: true })).toHaveCount(2);
    // A member who joined but hasn't verified can't sign in yet.
    await expect(section.getByText("pending.member@example.com")).toBeVisible();
    await expect(
      section.getByText("Waiting to verify", { exact: true }),
    ).toBeVisible();
    // All three members show their join date (the exact day depends on the
    // machine's timezone, so assert the year only).
    await expect(section.getByText(/Joined .* 2026/)).toHaveCount(3);
    // Other accounts' users never leak into this list.
    await expect(section.getByText("otheruser@example.com")).toHaveCount(0);
  });

  it("category counts exclude expenses in closed reports", async () => {
    // Close "2027 Test" (one of Development's expenses lives in it), then
    // verify the category count on Settings drops.
    await testPrisma.report.updateMany({
      where: { accountId: TEST_ACCOUNT_ID, name: "2027 Test" },
      data: { closed: true },
    });

    const page = await goto("/settings");
    const categories = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    const devRow = categories
      .locator("ul li")
      .filter({ hasText: "Development" });
    await expect(devRow.getByText("1 expense")).toBeVisible();

    // …and comes back once the report is reopened.
    await testPrisma.report.updateMany({
      where: { accountId: TEST_ACCOUNT_ID, name: "2027 Test" },
      data: { closed: false },
    });
    await page.reload();
    await expect(devRow.getByText("2 expenses")).toBeVisible();
    await page.close();
  });

  it("shows the seeded home address in the start/end section", async () => {
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Start/end location" }),
    });
    await expect(section.locator('input[name="homeAddress"]')).toHaveValue(
      "123 Test St, Testing, CA",
    );
  });

  it("lists categories alphabetically", async () => {
    const categories = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    // Categories are sorted alphabetically regardless of when they were
    // created.
    await expect(categories.locator("ul li")).toHaveText([
      "Development2 expenses",
      "Office Supplies1 expense",
      "Testing3 expenses",
    ]);
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
    // Duplicate: the action reports it inline; the existing row doesn't
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
    // Close "2027 Test" through the API (one of Development's expenses
    // lives in it), then verify the category count on Settings drops.
    await testPrisma.report.updateMany({
      where: { accountId: TEST_ACCOUNT_ID, name: "2027 Test" },
      data: { closed: true },
    });

    const page = await goto("/settings");
    const categories = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Categories" }),
    });
    const devRow = categories
      .locator("ul li")
      .filter({ hasText: "Development" });
    await expect(devRow.getByText("1 expense")).toBeVisible();

    // …and comes back once the report is reopened.
    await testPrisma.report.updateMany({
      where: { accountId: TEST_ACCOUNT_ID, name: "2027 Test" },
      data: { closed: false },
    });
    await page.reload();
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

    // Dismiss the confirmation: nothing is deleted.
    page.once("dialog", (d) => void d.dismiss());
    await row.getByRole("button", { name: /remove development/i }).click();
    await expect(row).toBeVisible();

    // Accept the confirmation; the category is deleted, its expenses stay.
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
    // The row is now an editor (input + Save/Cancel); locate it via the
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

  afterAll(async () => {
    await page?.close();
  });
});
