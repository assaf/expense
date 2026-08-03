import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPdfText } from "~/lib/receipt-ocr.server";
import { goto } from "./helpers/launchBrowser";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

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

  it("shows a lone closed report in its own section", async () => {
    // Even a single closed report leaves the main list — the separate
    // closed section exists as soon as there is at least one.
    await testPrisma.report.createMany({
      data: [{ name: "Lone Closed", accountId: TEST_ACCOUNT_ID, closed: true }],
      skipDuplicates: true,
    });

    const page = await goto("/export");
    const mainSection = page.locator("section").filter({
      has: page.getByRole("heading", {
        name: "Reports (PDF)",
        exact: true,
      }),
    });
    const closedSection = page.locator("section").filter({
      has: page.getByRole("heading", {
        name: "Closed reports (PDF)",
        exact: true,
      }),
    });

    await expect(closedSection).toBeVisible();
    await expect(
      closedSection.locator("li", { hasText: "Lone Closed" }),
    ).toBeVisible();
    // The lone closed report is out of the main list; open ones stay.
    await expect(
      mainSection.locator("li", { hasText: "Lone Closed" }),
    ).toHaveCount(0);
    await expect(
      mainSection.locator("li", { hasText: "2026 Test" }),
    ).toBeVisible();
    await page.close();
  });

  it("shows closed reports in their own section when there are several", async () => {
    // Two more closed reports (three total with "Lone Closed" from the
    // previous test) — closed reports now get a separate list.
    const now = "2026-06-15T00:00:00.000Z";
    await testPrisma.report.createMany({
      data: [
        { name: "Closed Alpha", accountId: TEST_ACCOUNT_ID, closed: true },
        { name: "Closed Beta", accountId: TEST_ACCOUNT_ID, closed: true },
      ],
      skipDuplicates: true,
    });
    await testPrisma.expense.createMany({
      data: [
        {
          id: "exp_closex1",
          type: "receipt",
          date: "2026-01-01",
          report: "Closed Alpha",
          category: "Testing",
          description: "",
          amount: "5.00",
          merchant: "Alpha Shop",
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
          id: "exp_closex2",
          type: "receipt",
          date: "2026-01-02",
          report: "Closed Beta",
          category: "Testing",
          description: "",
          amount: "6.00",
          merchant: "Beta Shop",
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

    const page = await goto("/export");
    const mainSection = page.locator("section").filter({
      has: page.getByRole("heading", {
        name: "Reports (PDF)",
        exact: true,
      }),
    });
    const closedSection = page.locator("section").filter({
      has: page.getByRole("heading", {
        name: "Closed reports (PDF)",
        exact: true,
      }),
    });

    // The closed section lists every closed report with its PDF link…
    await expect(closedSection).toBeVisible();
    await expect(
      closedSection.locator("li", { hasText: "Closed Alpha" }),
    ).toBeVisible();
    await expect(
      closedSection.locator("li", { hasText: "Closed Beta" }),
    ).toBeVisible();
    await expect(
      closedSection.locator("li", { hasText: "Lone Closed" }),
    ).toBeVisible();
    // …while the main list keeps only open reports.
    await expect(
      mainSection.locator("li", { hasText: "2026 Test" }),
    ).toBeVisible();
    await expect(
      mainSection.locator("li", { hasText: "Closed Alpha" }),
    ).toHaveCount(0);
    await page.close();
  });

  it("includes mileage with its route and map in the report PDF", async () => {
    // The "2026 Test" report contains the seeded mileage trip (32.00 mi,
    // two geocoded stops, rate $0.70 for 2026).
    const res = await page
      .context()
      .request.get("/export/report/2026%20Test.pdf");
    expect(res.status()).toBe(200);
    const buf = Buffer.from(await res.body());

    // The mileage label renders in full (no rate-independent blanking) and
    // the route addresses appear as the row's second line + appendix text.
    const text = await extractPdfText(buf);
    expect(text).toContain("32.00 mi @ $0.70 / mi");
    expect(text).toContain("123 Test St, Testing, CA");
    expect(text).toContain("456 Dev Ave, Coding, CA");
    expect(text).toContain("Mileage routes");

    // The mileage appendix page embeds the rendered route map image.
    const task = getDocument({ data: new Uint8Array(buf), verbosity: 0 });
    const doc = await task.promise;
    try {
      expect(doc.numPages).toBeGreaterThan(1);
      let imageOps = 0;
      for (let p = 1; p <= doc.numPages; p++) {
        const pageDoc = await doc.getPage(p);
        const ops = await pageDoc.getOperatorList();
        imageOps += ops.fnArray.filter(
          (fn) => fn === OPS.paintImageXObject,
        ).length;
      }
      expect(imageOps).toBeGreaterThan(0);
    } finally {
      await task.destroy();
    }
  });

  afterAll(async () => {
    await page?.close();
  });
});
