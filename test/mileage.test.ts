import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

/** Local-date string (YYYY-MM-DD) — matches the app's `todayDate()`. */
function todayLocal(): string {
  const now = new Date();
  const tz = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - tz).toISOString().slice(0, 10);
}

describe("Mileage expense", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/");
  });

  it("opens the mileage editor without writing a row", async () => {
    const before = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    await expect(page.getByText("Mileage expense")).toBeVisible();
    // The editor is a draft — nothing is persisted until Save.
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(before);
  });

  it("saves a new mileage expense", async () => {
    const before = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Add mileage").click();
    await page.waitForURL(/\/expense\/new\?type=mileage$/, {
      timeout: 10_000,
    });
    // A new mileage expense starts with today's date too.
    await expect(page.locator("input[type='date']")).toHaveValue(todayLocal());
    await page.getByText("Save").click();
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: 15_000,
    });
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(before + 1);
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
