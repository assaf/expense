import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";
import { goto } from "./helpers/launchBrowser";

describe("Export", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/export");
  });

  it("shows the export page", async () => {
    await expect(page.locator("h1")).toContainText("Export");
  });

  it("shows report entries for PDF downloads", async () => {
    // Should show "2026 Test" with expense count/total
    const reportEntry = page.locator("li:has-text('2026 Test')");
    await expect(reportEntry).toBeVisible();
    await expect(reportEntry).toContainText("expenses");
  });

  it("has an export-all ZIP link", async () => {
    const zipLink = page.locator('a[href="/export/all.zip"]');
    await expect(zipLink).toBeVisible();
  });

  afterAll(async () => {
    await page?.close();
  });
});
