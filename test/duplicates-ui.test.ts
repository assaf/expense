import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { duplicatePairKey } from "~/lib/duplicates";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

/** Local-date string (YYYY-MM-DD) — matches the app's `todayDate()`. */
function todayLocal(): string {
  const now = new Date();
  const tz = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - tz).toISOString().slice(0, 10);
}

/**
 * End-to-end coverage for duplicate detection:
 *  - both sides of a duplicate pair get a "Possible duplicate" strip
 *  - "Not a duplicate" dismisses the pair for good (persisted, survives reload)
 *  - "Remove" always goes through the confirm dialog (deletion has no undo)
 *  - the create editor warns live and flips Save to "Save anyway"
 *  - the mileage editor delete now confirms (it used to delete immediately)
 *
 * The inserted rows are scoped to the test account and removed in afterAll so
 * the shared seeded state is untouched for later test files.
 */
describe("Duplicate detection", () => {
  const today = todayLocal();
  const now = "2026-06-15T00:00:00.000Z";
  const PAIR_A = ["dup-a1", "dup-a2"];
  const PAIR_B = ["dup-b1", "dup-b2"];
  const BANNER_CO = "dup-bannerco";
  const MILEAGE_DEL = "dup-mileage-del";

  let page: Page;

  function receiptRow(id: string, merchant: string, amount: string) {
    return {
      id,
      type: "receipt",
      date: today,
      report: "",
      category: "Testing",
      description: "",
      amount,
      merchant,
      imageFile: "",
      imageMime: "",
      originalName: "",
      distanceMiles: null,
      locations: [],
      createdAt: now,
      updatedAt: now,
      accountId: TEST_ACCOUNT_ID,
    };
  }

  beforeAll(async () => {
    await testPrisma.expense.createMany({
      data: [
        receiptRow(PAIR_A[0]!, "DupCorp A", "9.99"),
        receiptRow(PAIR_A[1]!, "DupCorp A", "9.99"),
        receiptRow(PAIR_B[0]!, "DupCorp B", "8.88"),
        receiptRow(PAIR_B[1]!, "DupCorp B", "8.88"),
        receiptRow(BANNER_CO, "BannerCo", "8.75"),
        {
          id: MILEAGE_DEL,
          type: "mileage",
          date: today,
          report: "",
          category: "Travel",
          description: "Delete-confirm test",
          amount: "8.40",
          merchant: "",
          imageFile: "",
          imageMime: "",
          originalName: "",
          distanceMiles: "12.00",
          locations: [
            { address: "A St", lat: 34.05, lng: -118.24 },
            { address: "B St", lat: 34.06, lng: -118.25 },
          ],
          createdAt: now,
          updatedAt: now,
          accountId: TEST_ACCOUNT_ID,
        },
      ],
    });
    page = await goto("/");
  });

  /** Navigate and wait for React Router to hydrate (goto signs in fresh). */
  async function nav(path: string): Promise<void> {
    await page.goto(path, { waitUntil: "load", timeout: 15_000 });
    await page.waitForFunction(() => "__reactRouterContext" in window, {
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
  }

  it("badges both sides of a duplicate pair", async () => {
    await expect(page.getByText(/Possible duplicate of DupCorp A/)).toHaveCount(
      2,
    );
    await expect(page.getByText(/Possible duplicate of DupCorp B/)).toHaveCount(
      2,
    );
  });

  it("does not badge rows that merely share a date or amount", async () => {
    // DupCorp A and BannerCo share today's date and the same category but
    // differ in merchant/amount — no cross-match.
    await expect(page.getByText(/Possible duplicate of BannerCo/)).toHaveCount(
      0,
    );
  });

  it("'Not a duplicate' dismisses the pair for good", async () => {
    // Scope to the DupCorp A banner: all seeded dup rows share date AND
    // createdAt, so list order is a DB tie-break and an unscoped first()
    // can land on the DupCorp B banner, dismissing the wrong pair.
    await page
      .locator("li")
      .filter({ hasText: "Possible duplicate of DupCorp A" })
      .getByRole("button", { name: "Not a duplicate" })
      .first()
      .click();
    await expect(page.getByText(/Possible duplicate of DupCorp A/)).toHaveCount(
      0,
    );
    // The dismissal is persisted in the duplicate_dismissals join table,
    // stored ordered so the key matches either direction.
    const row = await testPrisma.duplicateDismissal.findFirst({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    expect(row).not.toBeNull();
    expect(duplicatePairKey(row!.expenseAId, row!.expenseBId)).toBe(
      duplicatePairKey(PAIR_A[0]!, PAIR_A[1]!),
    );
    // Survives a reload — the warning never nags again.
    await page.reload({ waitUntil: "load" });
    await expect(page.getByText(/Possible duplicate of DupCorp A/)).toHaveCount(
      0,
    );
  });

  it("'View' opens the other side of the pair", async () => {
    // Pair B is untouched (the dismiss test scoped to pair A), so its
    // banner's View link is the deterministic target for the URL assertion.
    await page
      .locator("li")
      .filter({ hasText: "Possible duplicate of DupCorp B" })
      .getByRole("link", { name: "View" })
      .first()
      .click();
    await page.waitForURL(/\/expense\/dup-b[12]$/);
    await nav("/");
  });

  it("'Remove' asks for confirmation before deleting", async () => {
    // Cancel keeps the row.
    await page
      .locator("li")
      .filter({ hasText: "DupCorp B" })
      .getByRole("button", { name: "Remove" })
      .first()
      .click();
    await expect(
      page.getByText("Delete this expense? This cannot be undone."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByText("Delete this expense? This cannot be undone."),
    ).toHaveCount(0);
    expect(
      await testPrisma.expense.findUnique({ where: { id: PAIR_B[0]! } }),
    ).not.toBeNull();

    // Confirming deletes exactly that row; the other side stops warning.
    await page
      .locator("li")
      .filter({ hasText: "DupCorp B" })
      .getByRole("button", { name: "Remove" })
      .first()
      .click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(/Possible duplicate of DupCorp B/)).toHaveCount(
      0,
    );
    await expect(
      testPrisma.expense.findUnique({ where: { id: PAIR_B[0]! } }),
    ).resolves.toBeNull();
    expect(
      await testPrisma.expense.findUnique({ where: { id: PAIR_B[1]! } }),
    ).not.toBeNull();
  });

  it("warns in the create editor and turns Save into 'Save anyway'", async () => {
    await nav("/expense/new");
    // The new receipt starts with today's date; filling merchant + amount
    // + the seeded row's category makes it look exactly like the seeded
    // BannerCo receipt (category/report/description are
    // equal-unless-different, so the category must agree).
    await page.fill('input[list="merchants"]', "BannerCo");
    await page.fill('input[type="number"]', "8.75");
    await page.getByLabel("Category").selectOption({ label: "Testing" });
    await expect(
      page.getByText(/This looks like a duplicate of BannerCo/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save anyway" }),
    ).toBeVisible();

    // Changing the amount clears the warning live — Save goes back.
    await page.fill('input[type="number"]', "9.00");
    await expect(
      page.getByText(/This looks like a duplicate of BannerCo/),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save anyway" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();

    // A differing category ("both empty or the same") also breaks the pair.
    await page.fill('input[type="number"]', "8.75");
    await page
      .getByLabel("Category")
      .selectOption({ label: "Office Supplies" });
    await expect(
      page.getByText(/This looks like a duplicate of BannerCo/),
    ).toHaveCount(0);
  });

  it("mileage delete asks for confirmation too", async () => {
    await nav(`/expense/${MILEAGE_DEL}`);
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByText("Delete this expense? This cannot be undone."),
    ).toBeVisible();
    // Cancel keeps it (the editor toolbar also has a Cancel — use the dialog's).
    await page.getByRole("button", { name: "Cancel" }).last().click();
    expect(
      await testPrisma.expense.findUnique({ where: { id: MILEAGE_DEL } }),
    ).not.toBeNull();
    // Confirm deletes it and returns home.
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete" }).last().click();
    await page.waitForURL("/");
    await expect(
      testPrisma.expense.findUnique({ where: { id: MILEAGE_DEL } }),
    ).resolves.toBeNull();
  });

  afterAll(async () => {
    await testPrisma.expense.deleteMany({
      where: {
        id: { in: [...PAIR_A, ...PAIR_B, BANNER_CO, MILEAGE_DEL] },
      },
    });
    await testPrisma.duplicateDismissal.deleteMany({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    await page?.close();
  });
});
