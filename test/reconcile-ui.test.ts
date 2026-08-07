import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";

/**
 * End-to-end reconciliation flow: upload a statement CSV → review the match
 * buckets → add an unmatched row as a new expense → complete → the home
 * page shows reconciled badges. Runs against the seeded test account
 * (Test Store 42.50 @ 2026-01-15 and OfficeMax 15.99 @ 2026-02-20).
 */
describe("Reconcile flow", () => {
  let page: Page;

  const STATEMENT_CSV = [
    "date,description,amount",
    "2026-01-15,TEST STORE PURCHASE,42.50",
    "2026-02-20,OFFICEMAX PRINTER PAPER,15.99",
    "2026-07-01,UNKNOWN COFFEE SHOP,9.99",
  ].join("\n");

  beforeAll(async () => {
    page = await goto("/reconcile");
  });

  afterAll(async () => {
    await page?.close();
  });

  it("lands on the upload page with a Reconcile entry point", async () => {
    await expect(
      page.getByRole("heading", { name: "Reconcile" }),
    ).toBeVisible();
    await expect(page.getByText("Upload a statement")).toBeVisible();
  });

  it("uploads the statement and shows the three buckets", async () => {
    await page.setInputFiles('input[name="file"]', {
      name: "statement.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(STATEMENT_CSV),
    });
    await page.getByRole("button", { name: "Match my expenses" }).click();
    // Redirect to the run page.
    await page.waitForURL(/\/reconcile\?run=/);
    // Auto-matched bucket: Test Store + OfficeMax.
    await expect(page.getByText("Matched automatically")).toBeVisible();
    await expect(page.getByText("TEST STORE PURCHASE")).toBeVisible();
    await expect(page.getByText("OFFICEMAX PRINTER PAPER")).toBeVisible();
    // The unknown coffee shop needs a decision.
    await expect(page.getByText("Needs your decision")).toBeVisible();
    await expect(page.getByText("UNKNOWN COFFEE SHOP")).toBeVisible();
  });

  it("adds the unmatched coffee shop as a new expense", async () => {
    const row = page.locator("li", { hasText: "UNKNOWN COFFEE SHOP" }).first();
    await row.getByRole("button", { name: "Add as new expense" }).click();
    await page.getByLabel("Report (required)").selectOption("2026 Test");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Will be added as new expenses")).toBeVisible();
  });

  it("completes the reconciliation and shows the summary", async () => {
    await page.getByRole("button", { name: "Complete reconciliation" }).click();
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await expect(page.getByText("Reconciled", { exact: true })).toBeVisible();
    await expect(
      page.getByText(/2 expenses matched · 1 added as new expenses/),
    ).toBeVisible();
  });

  it("shows reconciled badges on the home page", async () => {
    await page.goto("/", { waitUntil: "load" });
    // Reconcile entry point in the header nav.
    await expect(
      page.getByRole("link", { name: "Reconcile", exact: true }),
    ).toBeVisible();
    // The matched expenses and the created one all carry the badge.
    const badges = page.getByText("Reconciled", { exact: true });
    await expect(badges.first()).toBeVisible();
    await expect(badges).toHaveCount(3);
    // The created expense is on the list with its statement receipt image.
    await expect(page.getByText("Unknown Coffee Shop")).toBeVisible();
  });
});
