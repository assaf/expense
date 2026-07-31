import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";
import { goto } from "./helpers/launchBrowser";

describe("Mileage expense", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/");
  });

  it("creates a mileage expense", async () => {
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\//, { timeout: 10_000 });
    await expect(page.getByText("Mileage expense")).toBeVisible();
  });

  it("opens and views the seeded mileage expense", async () => {
    // Navigate to the seeded mileage (amount 22.40)
    await page.goto("/", { waitUntil: "load" });
    await page.getByRole("link", { name: /22\.40/ }).click();
    await page.waitForURL(/\/expense\//, { timeout: 10_000 });
    await expect(page.getByText("Mileage expense")).toBeVisible();
    const amountInput = page.locator("input[type='number']");
    await expect(amountInput).toHaveValue("22.40");
  });

  it("shows the mileage in the list", async () => {
    await page.goto("/", { waitUntil: "load" });
    await expect(page.getByRole("link", { name: /22\.40/ })).toBeVisible();
  });

  afterAll(async () => {
    await page?.close();
  });
});
