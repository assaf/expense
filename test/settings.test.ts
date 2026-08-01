import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";

// `page` is shared read-only across the tests above; the flash tests drive
// their own page so they can add rows without disturbing the rest.
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
    // Reports render in creation order (oldest first); categories are sorted
    // alphabetically regardless of when they were created.
    await expect(reports.locator("ul li")).toHaveText([
      "2026 Test",
      "2027 Test",
    ]);
    await expect(categories.locator("ul li")).toHaveText([
      "Development",
      "Office Supplies",
      "Testing",
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
      "Development",
      "New Category",
      "Office Supplies",
      "Testing",
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

  afterAll(async () => {
    await page?.close();
  });
});
