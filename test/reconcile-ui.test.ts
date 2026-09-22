import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";
import { fileTransfer } from "./helpers/dropFile";
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
    await page.goto("/expenses", { waitUntil: "load" });
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

  it("lists an in-progress draft on the landing page and lets it be discarded, then re-uploads fresh", async () => {
    await page.goto("/reconcile", { waitUntil: "load" });
    await page.waitForTimeout(500);
    const csv = [
      "date,description,amount",
      "2026-08-01,NEW COFFEE SHOP,8.75",
    ].join("\n");
    await page.setInputFiles('input[name="file"]', {
      name: "draft.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page.getByRole("button", { name: "Match my expenses" }).click();
    await page.waitForURL(/\/reconcile\?run=/);

    // Back on the landing, the draft is listed as in progress.
    await page.goto("/reconcile", { waitUntil: "load" });
    await page.waitForTimeout(500);
    await expect(page.getByText("In progress")).toBeVisible();
    const row = page.locator("li", { hasText: "draft.csv" }).first();
    await row.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByText("In progress")).not.toBeVisible();

    // Re-uploading the same file parses fresh; no stale draft blocks it.
    await page.setInputFiles('input[name="file"]', {
      name: "draft.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page.getByRole("button", { name: "Match my expenses" }).click();
    await page.waitForURL(/\/reconcile\?run=/);
    await expect(page.getByText("Needs your decision")).toBeVisible();
  });

  it("drags a statement onto the page: dashed outline, then upload", async () => {
    await page.goto("/reconcile", { waitUntil: "load" });
    await page.waitForTimeout(500);
    const main = page.locator("main#main-content");
    const submit = page.getByRole("button", { name: "Match my expenses" });
    const STATEMENT_CSV = [
      "date,description,amount",
      "2026-08-02,DROPPED CAFE,4.25",
    ].join("\n");

    // A drop carries its files on a DataTransfer, which only the page can
    // build: one fresh transfer per event (a DataTransfer is spent by the
    // drop it carries).

    // Over the page: the whole page is the drop target (the header is not
    // special), highlighted with the same dashed outline the expense list
    // shows and announced to screen readers.
    const hover = await fileTransfer(page, {
      name: "dropped-statement.csv",
      type: "text/csv",
      body: STATEMENT_CSV,
    });
    await page.dispatchEvent("h1", "dragenter", { dataTransfer: hover });
    await expect(main).toHaveClass(/outline-dashed/);
    await expect(
      page.locator('.sr-only[role="status"][aria-live="polite"]'),
    ).toContainText("Statement file detected");

    // Leaving clears the highlight.
    await page.dispatchEvent("h1", "dragleave", { dataTransfer: hover });
    await expect(main).not.toHaveClass(/outline-dashed/);

    // A file the page does not take is ignored: browsers drop the picker's
    // accept filter, so the drop target screens, and nothing is submitted.
    const ignored = await fileTransfer(page, {
      name: "note.png",
      type: "image/png",
      body: "not a statement",
    });
    await page.dispatchEvent("h1", "drop", { dataTransfer: ignored });
    await expect(submit).toBeDisabled();

    // The statement fills the picker, so the browser shows the filename and
    // the submit enables exactly as if the file had been chosen.
    const statement = await fileTransfer(page, {
      name: "dropped-statement.csv",
      type: "text/csv",
      body: STATEMENT_CSV,
    });
    await page.dispatchEvent("h1", "drop", { dataTransfer: statement });
    await expect(submit).toBeEnabled();
    expect(
      await page.evaluate(() => {
        const input = document.querySelector('input[type="file"]');
        return input instanceof HTMLInputElement
          ? (input.files?.[0]?.name ?? "")
          : "";
      }),
    ).toBe("dropped-statement.csv");
    await submit.click();
    await page.waitForURL(/\/reconcile\?run=/);
    await expect(page.getByText("DROPPED CAFE")).toBeVisible();
  });
});
