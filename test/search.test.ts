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

  it("suggests known merchants and categories with counts", async () => {
    const merchant = page.locator(
      "#expense-search-suggestions option[value='OfficeMax']",
    );
    await expect(merchant).toHaveCount(1);
    await expect(merchant).toHaveAttribute("label", "1 expense");
    const category = page.locator(
      "#expense-search-suggestions option[value='Development']",
    );
    await expect(category).toHaveCount(1);
    await expect(category).toHaveAttribute(
      "label",
      "2 expenses in this category",
    );
    const report = page.locator(
      "#expense-search-suggestions option[value='report:2026 Test']",
    );
    await expect(report).toHaveCount(1);
    await expect(report).toHaveAttribute("label", "4 expenses as a report");
    const merchantOp = page.locator(
      "#expense-search-suggestions option[value='merchant:OfficeMax']",
    );
    await expect(merchantOp).toHaveCount(1);
    await expect(merchantOp).toHaveAttribute(
      "label",
      "1 expense as a merchant",
    );
  });

  it("filters by a picked suggestion and shows its total", async () => {
    await search("DevShop");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await expect(
      page.getByText("Showing 1 of 6 expenses · $99.99 total"),
    ).toBeVisible();
  });

  it("filters by description content via the operator", async () => {
    await search("description:printer");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await expect(
      page.getByText("Showing 1 of 6 expenses · $15.99 total"),
    ).toBeVisible();
  });

  it("matches a description phrase via the operator", async () => {
    // The mileage row's description, not a receipt.
    await search("description:client visit");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await expect(
      page.getByText("Showing 1 of 6 expenses · $22.40 total"),
    ).toBeVisible();
  });

  it("matches mileage route addresses", async () => {
    await search("coding");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await expect(
      page.locator("main ul li").getByText("Business · 32.00 mi"),
    ).toBeVisible();
  });

  it("filters by a spaced report name via the operator", async () => {
    await search("report:2026 test");
    await expect(page.locator("main ul li")).toHaveCount(4);
    await expect(
      page.getByText("Showing 4 of 6 expenses · $80.89 total"),
    ).toBeVisible();
  });

  it("filters by category via the operator", async () => {
    await search("category:development");
    await expect(page.locator("main ul li")).toHaveCount(2);
    await expect(
      page.getByText("Showing 2 of 6 expenses · $122.39 total"),
    ).toBeVisible();
  });

  it("ANDs operators of different keys", async () => {
    await search("report:2026 test category:testing");
    // Test Store (42.50) + the incomplete 0.00 row, both in 2026 Test.
    await expect(page.locator("main ul li")).toHaveCount(2);
    await expect(
      page.getByText("Showing 2 of 6 expenses · $42.50 total"),
    ).toBeVisible();
  });

  it("keeps free text before an operator as words", async () => {
    await search("printer paper category:office supplies");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await expect(
      page.getByText("Showing 1 of 6 expenses · $15.99 total"),
    ).toBeVisible();
  });

  it("treats unknown colon tokens as free text", async () => {
    await search("10:30");
    await expect(
      page.getByText("No expenses match these filters."),
    ).toBeVisible();
  });

  it("matches mileage route addresses", async () => {
    await search("coding");
    await expect(page.locator("main ul li")).toHaveCount(1);
    await expect(
      page.locator("main ul li").getByText("Business · 32.00 mi"),
    ).toBeVisible();
  });

  it("shows a count of matching expenses and their total", async () => {
    await search("development");
    // DevShop (99.99) + the Development mileage row (22.40), summed with
    // exact decimal math.
    await expect(
      page.getByText("Showing 2 of 6 expenses · $122.39 total"),
    ).toBeVisible();
  });

  it("sums a single merchant's spend", async () => {
    await search("OfficeMax");
    await expect(
      page.getByText("Showing 1 of 6 expenses · $15.99 total"),
    ).toBeVisible();
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
