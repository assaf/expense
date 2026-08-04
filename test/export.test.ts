import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ulid } from "ulid";
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

  it("includes mileage with its type, rate, distance, route, and a route map in the report PDF", async () => {
    // The "2026 Test" report contains the seeded mileage trip (32.00 mi,
    // two geocoded stops; business rate for Mar 2026 is $0.725).
    const res = await page
      .context()
      .request.get("/export/report/2026%20Test.pdf");
    expect(res.status()).toBe(200);
    const buf = Buffer.from(await res.body());

    // The category row shows the IRS type and rate in the merchant column
    // and the distance + route addresses as its second line.
    const text = await extractPdfText(buf);
    expect(text).toContain("Business · $0.725/mi");
    expect(text).toContain("(32.00 miles)");
    expect(text).toContain("123 Test St, Testing, CA");
    expect(text).toContain("456 Dev Ave, Coding, CA");

    // The route map lives in the appendix, with the date, mileage, and
    // amount listed beside it ("Mileage" + "32.00 miles" — no parens —
    // are the appendix's field label and value), and the trip's stops
    // listed below it ("Start/end", "Stop 1" — no header).
    expect(text).toContain("Receipts & routes");
    expect(text).toContain("Mileage");
    expect(text).toContain("32.00 miles");
    expect(text).toContain("Mar 10, 2026");
    expect(text).toContain("$22.40");
    expect(text).toContain("Start/end");
    expect(text).toContain("Stop 1");
    expect(text).not.toContain("Locations");

    // The trip's route map is embedded as an image (the fallback straight-
    // line render — the seeded expense predates saved route geometry).
    const task = getDocument({ data: new Uint8Array(buf), verbosity: 0 });
    const doc = await task.promise;
    try {
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

  it("includes uncategorized expenses under 'No category'", async () => {
    // Seed a receipt in the "2026 Test" report with no category — the PDF
    // must include it rather than drop it, under a "No category" heading.
    const id = ulid();
    await testPrisma.expense.create({
      data: {
        id,
        accountId: TEST_ACCOUNT_ID,
        type: "receipt",
        date: "2026-05-20",
        report: "2026 Test",
        category: "",
        description: "Uncategorized lunch",
        amount: "13.37",
        merchant: "Random Diner",
        imageFile: "",
        imageMime: "",
        originalName: "",
        locations: [],
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
      },
    });
    try {
      const res = await page
        .context()
        .request.get("/export/report/2026%20Test.pdf");
      expect(res.status()).toBe(200);
      const text = await extractPdfText(Buffer.from(await res.body()));
      expect(text).toContain("No category");
      expect(text).toContain("Random Diner");
      expect(text).toContain("$13.37");
    } finally {
      await testPrisma.expense.deleteMany({ where: { id } });
    }
  });

  afterAll(async () => {
    await page?.close();
  });
});
