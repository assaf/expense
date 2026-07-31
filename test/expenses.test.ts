import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";

describe("Expense CRUD", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/");
  });

  it("creates a new receipt via the add button", async () => {
    // Click "Add receipt"
    await page.getByText("Add receipt").click();
    await page.waitForURL(/\/expense\//, { timeout: 10_000 });
    // The editor should open; extract the id from the URL
    await page.waitForURL(/\/expense\//, { timeout: 10_000 });
    // Should be on the receipt editor (title is "New receipt" if merchant empty)
    await expect(page.locator("h1")).toBeVisible();
    // Amount should be focused on open
    await expect(page.locator("input[type='number']")).toBeFocused();
  });

  it("fills and saves a receipt expense", async () => {
    // Fill merchant
    const merchantInput = page.locator("input[list='merchants']");
    await merchantInput.fill("Test Merchant");
    // Fill amount
    const amountInput = page.locator("input[type='number']");
    await amountInput.fill("123.45");
    // Select report
    await page.locator("select").first().selectOption("2026 Test");
    // Select category
    const selects = page.locator("select");
    await selects.nth(1).selectOption("Testing");
    // Submit
    await page.getByText("Save").click();
    // Should redirect to home page
    await page.waitForURL("/", { timeout: 10_000 });
    // The new expense should appear in the list
    await expect(page.getByText("Test Merchant")).toBeVisible();
  });

  it("shows the new expense in the list and opens it", async () => {
    await page.goto("/", { waitUntil: "load" });
    await expect(page.getByText("Test Merchant")).toBeVisible();
    // Click on it to open the editor
    await page.getByText("Test Merchant").click();
    await page.waitForURL(/\/expense\//, { timeout: 10_000 });
    // The merchant should be pre-filled
    await expect(page.locator("input[list='merchants']")).toHaveValue(
      "Test Merchant",
    );
  });

  it("deletes an expense", async () => {
    // Navigate to the expense we created
    await page.goto("/", { waitUntil: "load" });
    await page.getByText("Test Merchant").click();
    await page.waitForURL(/\/expense\//, { timeout: 10_000 });
    // Click delete
    await page.getByText("Delete").click();
    // Confirm dialog
    await page.getByText("Delete").last().click();
    // Should redirect to home
    await page.waitForURL("/", { timeout: 10_000 });
    // The expense should no longer be in the list
    await expect(page.getByText("Test Merchant")).not.toBeVisible();
  });

  afterAll(async () => {
    await page?.close();
  });
});
