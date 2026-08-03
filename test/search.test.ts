import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";
import { seedTestData } from "./helpers/seedTestData";

describe("Expense search", () => {
  let page: Page;

  beforeAll(async () => {
    await seedTestData();
    page = await goto("/");
  });

  afterAll(async () => {
    await page?.close();
  });

  /** Type into the search box, then wait out the 200ms debounce. */
  async function search(text: string) {
    await page.getByLabel("Search expenses").fill(text);
    await page.waitForTimeout(400);
  }

  it("filters rows by merchant", async () => {
    await search("OfficeMax");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await expect(page.getByText("OfficeMax")).toBeVisible();
    await expect(page.getByText("Test Store")).not.toBeVisible();
  });

  it("matches every word of a multi-word query", async () => {
    await search("office supplies");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await expect(page.getByText("OfficeMax")).toBeVisible();
  });

  it("filters by amount", async () => {
    await search("$42");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await expect(page.getByText("Test Store")).toBeVisible();
  });

  it("filters by description", async () => {
    await search("printer paper");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await expect(page.getByText("OfficeMax")).toBeVisible();
  });

  it("filters by category", async () => {
    await search("development");
    // The mileage row and DevShop share the "Development" category.
    await expect(page.locator("main ul li")).toHaveCount(2);
  });

  it("matches mileage route addresses", async () => {
    await search("coding");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await expect(page.locator("main ul li").getByText("Mileage")).toBeVisible();
  });

  it("shows a count of matching expenses", async () => {
    await search("development");
    await expect(page.getByText("Showing 2 of 6 expenses")).toBeVisible();
  });

  it("clears the filter", async () => {
    await search("OfficeMax");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await page.getByRole("button", { name: "Clear search" }).click();
    await page.waitForTimeout(400);
    await expect(page.locator("main ul li")).toHaveCount(6);
  });

  it("shows an empty state when nothing matches", async () => {
    await search("zzzzz");
    await expect(
      page.getByText("No expenses match these filters."),
    ).toBeVisible();
  });
});
