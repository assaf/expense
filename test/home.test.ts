import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";

describe("Home page", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/");
  });

  it("shows the title", async () => {
    await expect(page.locator("h1")).toContainText("Expense");
  });

  it("shows the total count and amount of all expenses", async () => {
    // Six seeded expenses (the 0.00 row counts toward the number, adds
    // nothing to the sum: 42.50 + 15.99 + 22.40 + 99.99 + 12.00).
    await expect(page.getByText("6 expenses · $192.88 total")).toBeVisible();
  });

  it("shows the add receipt button", async () => {
    await expect(page.getByText("Add receipt")).toBeVisible();
  });

  it("shows expense rows for seeded data", async () => {
    // At least the Test Store merchant should appear
    await expect(page.getByText("Test Store")).toBeVisible();
  });

  it("shows the description next to the merchant, single line", async () => {
    // OfficeMax is seeded with the description "Printer paper".
    const row = page.locator("li").filter({ hasText: "OfficeMax" }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Printer paper");
    // Both texts live in the same line: the merchant span and the
    // lighter-gray description span inside it (not the meta line below).
    await expect(row.locator("span.truncate")).toContainText(
      /OfficeMax.*Printer paper/,
    );
  });

  afterAll(async () => {
    await page?.close();
  });
});
