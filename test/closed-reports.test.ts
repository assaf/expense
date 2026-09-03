import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

/**
 * Closed reports: off the home page (no summary card, no expenses) and not
 * selectable in the expense editor. The database is re-seeded before this
 * file, so the fixtures created in beforeAll can stay in place.
 */
describe("Closed reports", () => {
  let page: Page;

  beforeAll(async () => {
    // One open and one closed report, each with an expense, so the home
    // page filtering can be asserted against both sides.
    const now = "2026-06-15T00:00:00.000Z";
    await testPrisma.report.createMany({
      data: [
        { name: "Open Q3", accountId: TEST_ACCOUNT_ID, closed: false },
        { name: "Closed Q3", accountId: TEST_ACCOUNT_ID, closed: true },
      ],
      skipDuplicates: true,
    });
    await testPrisma.expense.createMany({
      data: [
        {
          id: "exp_openq3",
          type: "receipt",
          date: "2026-06-01",
          report: "Open Q3",
          category: "Testing",
          description: "",
          amount: "10.00",
          merchant: "Open Report Shop",
          imageFile: "",
          imageMime: "",
          originalName: "",
          distanceMiles: null,
          locations: [],
          createdAt: now,
          updatedAt: now,
          accountId: TEST_ACCOUNT_ID,
        },
        {
          id: "exp_closedq3",
          type: "receipt",
          date: "2026-06-02",
          report: "Closed Q3",
          category: "Testing",
          description: "",
          amount: "20.00",
          merchant: "Closed Report Shop",
          imageFile: "",
          imageMime: "",
          originalName: "",
          distanceMiles: null,
          locations: [],
          createdAt: now,
          updatedAt: now,
          accountId: TEST_ACCOUNT_ID,
        },
      ],
    });
    page = await goto("/");
  });

  it("hides closed reports and their expenses from the home page", async () => {
    // The open report's expense is shown; the closed report's is not.
    await expect(page.getByText("Open Report Shop")).toBeVisible();
    await expect(page.getByText("Closed Report Shop")).toHaveCount(0);
    // The closed report is not offered as a search suggestion either.
    await expect(
      page.locator(
        "#expense-search-suggestions option[value='report:Closed Q3']",
      ),
    ).toHaveCount(0);
    await expect(
      page.locator(
        "#expense-search-suggestions option[value='report:Open Q3']",
      ),
    ).toHaveCount(1);
    // Seeded fixtures are untouched.
    await expect(page.getByText("Test Store")).toBeVisible();
  });

  it("does not offer closed reports in the expense editor", async () => {
    const editor = await goto("/expense/exp_openq3");
    const reportSelect = editor.locator("select").first();
    // Options inside a closed <select> are never "visible" to Playwright,
    // assert on presence instead.
    await expect(
      reportSelect.locator("option", { hasText: "2026 Test" }),
    ).toHaveCount(1);
    await expect(
      reportSelect.locator("option", { hasText: "Closed Q3" }),
    ).toHaveCount(0);
    await editor.close();
  });

  it("shows a closed-report expense as read-only with no Save button", async () => {
    // The expense lives in a closed report; the editor must be read-only:
    // fields are disabled and the Save button is not rendered.
    const editor = await goto("/expense/exp_closedq3");
    const reportSelect = editor.locator("select").first();
    await expect(reportSelect).toHaveValue("Closed Q3");
    await expect(reportSelect).toBeDisabled();
    await expect(editor.getByRole("button", { name: "Save" })).toHaveCount(0);
    await editor.close();
  });

  it("refuses to save an expense that is already in a closed report", async () => {
    // The UI hides Save for closed-report expenses, but the gate is the
    // server action: a hand-crafted same-origin save must get the
    // badRequest, not silently succeed (regression guard for the
    // closedReportNames extraction in expense.$id.tsx).
    const res = await page.request.post("/expense/exp_closedq3", {
      form: { intent: "save", date: "2026-06-02", amount: "20.00" },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("closed report");
  });

  it("rejects saving an expense into a closed report", async () => {
    const editor = await goto("/expense/exp_openq3");
    // The UI never offers the closed report, so exercise the server guard
    // directly with a same-origin request (cookies included). React Router
    // streams the app shell for document requests, so assert the status and
    // that the expense was left untouched.
    const res = await editor.context().request.post("/expense/exp_openq3", {
      form: {
        intent: "save",
        date: "2026-01-01",
        merchant: "Open Report Shop",
        amount: "10.00",
        report: "Closed Q3",
        category: "Testing",
        description: "",
      },
    });
    expect(res.status()).toBe(400);
    expect(
      await testPrisma.expense.count({
        where: { id: "exp_openq3", report: "Open Q3" },
      }),
    ).toBe(1);
    await editor.close();
  });

  afterAll(async () => {
    await page?.close();
  });
});
