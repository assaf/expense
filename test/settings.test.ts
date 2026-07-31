import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";

describe("Settings", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/settings");
  });

  it("shows the settings page", async () => {
    await expect(page.locator("h1")).toContainText("Settings");
  });

  it("shows reports, categories, mileage rates, and home fields", async () => {
    await expect(page.getByText("Reports")).toBeVisible();
    await expect(page.getByText("Categories")).toBeVisible();
    await expect(page.getByText("Mileage rates")).toBeVisible();
    await expect(page.getByText("Home location")).toBeVisible();
  });

  it("displays the seeded reports", async () => {
    await expect(page.getByText("2026 Test")).toBeVisible();
    await expect(page.getByText("2027 Test")).toBeVisible();
  });

  afterAll(async () => {
    await page?.close();
  });
});
