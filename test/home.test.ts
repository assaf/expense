import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";
import { goto } from "./helpers/launchBrowser";

describe("Home page", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/");
  });

  it("shows the title", async () => {
    await expect(page.locator("h1")).toContainText("Expenses");
  });

  it("shows report summary cards", async () => {
    // Should have cards for seeded reports
    await expect(page.locator("section button").first()).toBeVisible();
    // "2026 Test" report summary card should be present
    await expect(page.getByRole("button", { name: /2026 Test/ })).toBeVisible();
  });

  it("shows the add receipt button", async () => {
    await expect(page.getByText("Add receipt")).toBeVisible();
  });

  it("shows expense rows for seeded data", async () => {
    // At least the Test Store merchant should appear
    await expect(page.getByText("Test Store")).toBeVisible();
  });

  afterAll(async () => {
    await page?.close();
  });
});
