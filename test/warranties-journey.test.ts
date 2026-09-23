import { expect } from "playwright/test";
import type { Page } from "playwright";
import PDFDocument from "pdfkit";
import { beforeAll, describe, it } from "vite-plus/test";
import { fileTransfer } from "./helpers/dropFile";
import { goto } from "./helpers/launchBrowser";

/** A real receipt image (stored normalized) and a real PDF (a terms file in
 * this flow). Both ride the same document picker. */
const IMAGE_FIXTURE = "test/fixtures/images/blue-bottle.png";
const PDF_FIXTURE = "test/fixtures/pdf/Receipt-2260-2349.pdf";

/** A one-page PDF with a real text layer, so pdf.js reads it back as text
 * (the dropped-document path only rasterizes a PDF with no usable text). */
function tinyPdf(text: string): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  const doc = new PDFDocument({ size: "LETTER" });
  doc.on("data", (c: Buffer) => chunks.push(c));
  doc.on("end", () => resolve(Buffer.concat(chunks)));
  doc.on("error", reject);
  doc.fontSize(12).text(text);
  doc.end();
  return promise;
}

/**
 * The warranty surface end to end: empty state, create with documents, the
 * expiry grouping, document serving, removing one document, and delete.
 * The suite clock is pinned to 2026-07-15, so the dates below are fixed.
 */
describe("warranties journey", () => {
  let page: Page;

  beforeAll(async () => {
    page = await goto("/warranties");
  });

  it("creates a warranty with documents, then edits and deletes it", async () => {
    await expect(
      page.getByRole("heading", { name: "Warranties" }),
    ).toBeVisible();
    // Nothing yet: the header action and the empty-state action are the two
    // ways in.
    await expect(page.getByRole("link", { name: "New warranty" })).toHaveCount(
      2,
    );

    await page.getByRole("link", { name: "New warranty" }).first().click();
    await page.waitForURL(/\/warranty\/new$/, { timeout: 10_000 });
    // React Router remounts the route element once the loader settles; a beat
    // past that keeps the fills on the instance that survives.
    await page.waitForTimeout(200);

    // A rejected save leaves a usable form: the error shows and the
    // transition overlay is gone (the shared flow clears it), so the user can
    // fix the field and submit again.
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert")).toContainText("needs a product");
    await expect(page.getByText("Saving…")).toHaveCount(0);

    await page.getByLabel("Product", { exact: true }).fill("Espresso machine");
    await page.getByLabel("Merchant", { exact: true }).fill("Williams Sonoma");
    await page.getByLabel("Value", { exact: true }).fill("1299");
    await page.getByLabel("Purchased", { exact: true }).fill("2026-07-15");
    await page.getByLabel("Expires", { exact: true }).fill("2027-03-15");
    await page
      .getByLabel("Terms", { exact: true })
      .fill("Two years parts and labor.");

    // Nothing uploads before Save; the picks are held and counted.
    await page
      .locator('input[type="file"]')
      .setInputFiles([IMAGE_FIXTURE, PDF_FIXTURE]);
    await expect(page.getByText("2 documents")).toBeVisible();

    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForURL((url) => url.pathname === "/warranties", {
      timeout: 15_000,
    });

    // Well past the 90-day window, so it lands under "Expiring later".
    await expect(
      page.getByRole("heading", { name: "Expiring later" }),
    ).toBeVisible();
    await expect(page.getByText("Espresso machine")).toBeVisible();
    await expect(page.getByText("2 documents")).toBeVisible();
    await expect(page.getByText("Expires 2027-03-15")).toBeVisible();

    // Open it and serve the first document (the image).
    const rowLink = page.getByRole("link", { name: /Espresso machine/ });
    const href = (await rowLink.getAttribute("href"))!;
    await rowLink.click();
    await page.waitForURL(`**${href}`, { timeout: 10_000 });
    await expect(page.getByText("2 documents")).toBeVisible();

    const image = await page.request.get(`${href}/document/0`);
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toMatch(/^image\//);
    expect((await image.body()).length).toBeGreaterThan(0);

    // Remove the PDF (the second document); the count follows.
    await page.getByRole("button", { name: "Remove Document" }).nth(1).click();
    await expect(page.getByText("1 document")).toBeVisible();
    // Its blob is gone: the index no longer resolves.
    const removed = await page.request.get(`${href}/document/1`);
    expect(removed.status()).toBe(404);

    // Delete the record: back to the empty state. The prompt is the shared
    // confirm dialog, so it has to name what is being deleted.
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Delete this warranty?")).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).last().click();
    await page.waitForURL((url) => url.pathname === "/warranties", {
      timeout: 15_000,
    });
    await expect(
      page.getByText(
        /Drop a receipt, a warranty card, or a terms PDF anywhere/,
      ),
    ).toBeVisible();
    await expect(page.getByText("Espresso machine")).toHaveCount(0);
  });

  it("starts a warranty from a receipt and links back to it", async () => {
    // A receipt to hang the warranty on.
    await page.goto("/expenses", { waitUntil: "load" });
    await page.getByRole("button", { name: "Receipt" }).click();
    await page.waitForURL(/\/expense\/new$/, { timeout: 10_000 });
    await page.waitForTimeout(200);
    await page.locator("input[list='merchants']").fill("Blue Bottle");
    await page.locator("input[type='number']").fill("18.50");
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForURL((url) => url.pathname === "/expenses", {
      timeout: 15_000,
    });

    await page.getByText("Blue Bottle").click();
    await page.waitForURL(/\/expense\/[^/]+$/, { timeout: 10_000 });

    // The card starts the warranty, prefilled from the receipt.
    await page.getByRole("link", { name: "Add warranty" }).click();
    await page.waitForURL(/\/warranty\/new\?expenseId=/, { timeout: 10_000 });
    await page.waitForTimeout(200);
    await expect(page.getByLabel("Merchant", { exact: true })).toHaveValue(
      "Blue Bottle",
    );
    await expect(page.getByLabel("Value", { exact: true })).toHaveValue(
      "18.50",
    );
    await expect(page.getByLabel("Purchased", { exact: true })).toHaveValue(
      "2026-07-15",
    );

    // No expiry is a valid end state, not a missing value. The terms file
    // arrives by drop, not the picker: a dropped file becomes a pick.
    await page.getByLabel("Product", { exact: true }).fill("Coffee grinder");
    await page.locator("main").dispatchEvent("drop", {
      dataTransfer: await fileTransfer(page, {
        name: "terms.pdf",
        type: "application/pdf",
        body: "%PDF-1.4 two year warranty terms",
      }),
    });
    await expect(page.getByText("1 document")).toBeVisible();

    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForURL((url) => url.pathname === "/warranties", {
      timeout: 15_000,
    });
    await expect(
      page.getByRole("heading", { name: "No expiration date" }),
    ).toBeVisible();
    // The row's badge keeps the label's own wording ("No expiry").
    const row = page.getByRole("link", { name: /Coffee grinder/ });
    await expect(row).toContainText("No expiry");
    await expect(row).toContainText("1 document");

    // The receipt carries the card, and the card leads back.
    await page.goto("/expenses", { waitUntil: "load" });
    await page.getByText("Blue Bottle").click();
    await page.waitForURL(/\/expense\/[^/]+$/, { timeout: 10_000 });
    const card = page.getByRole("link", { name: /Coffee grinder/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText("No expiry");
    await card.click();
    await page.waitForURL(/\/warranty\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel("Product", { exact: true })).toHaveValue(
      "Coffee grinder",
    );

    // A merchant with a curated coverage policy fills the empty terms, and
    // terms the user wrote are never replaced.
    const terms = page.getByLabel("Terms", { exact: true });
    await page.getByLabel("Merchant", { exact: true }).fill("Costco");
    await expect(terms).toHaveValue(/90 days/);
    await expect(terms).toHaveValue(/checked 2026-09/);
    await terms.fill("My own note");
    await page.getByLabel("Merchant", { exact: true }).fill("Costco Wholesale");
    await expect(terms).toHaveValue("My own note");

    // Saving an edit goes back to the list, with the change in it.
    await page.getByLabel("Product", { exact: true }).fill("Coffee grinder XL");
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForURL((url) => url.pathname === "/warranties", {
      timeout: 15_000,
    });
    const renamed = page.getByRole("link", { name: /Coffee grinder XL/ });
    await expect(renamed).toBeVisible();
    await expect(renamed).toContainText("Coffee grinder XL");
    // The old spelling is gone: the list shows the saved row, not a stale one.
    await expect(
      page.getByRole("link", { name: /Coffee grinder,/ }),
    ).toHaveCount(0);
  });

  it("files a dropped document as a warranty of its own", async () => {
    await page.goto("/warranties", { waitUntil: "load" });

    // A terms PDF: it carries a text layer, so the server reads it as text
    // (no rasterizing, no OCR).
    const pdf = await tinyPdf(
      "WARRANTY TERMS: this espresso machine is covered for 24 months " +
        "from the date of purchase against manufacturing defects.",
    );
    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/warranty") && r.request().method() === "POST",
        { timeout: 60_000 },
      ),
      page.locator("main").dispatchEvent("drop", {
        dataTransfer: await fileTransfer(page, {
          name: "cappuccino-machine.pdf",
          type: "application/pdf",
          body: [...pdf],
        }),
      }),
    ]);
    expect(createResponse.ok()).toBeTruthy();
    const { id } = (await createResponse.json()) as { id: string };

    // The list reloads with the new row. What it is named depends on whether
    // the document could be read at all (the local model in dev, no key in
    // CI), so the row is identified by its id and only the facts that hold
    // either way are asserted: it exists, and it carries the document.
    const row = page.locator(`main a[href="/warranty/${id}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText("1 document");

    // The document is served as itself: a PDF stays a PDF (a receipt
    // rasterizes because it is displayed as an image).
    const document = await page.request.get(`/warranty/${id}/document/0`);
    expect(document.status()).toBe(200);
    expect(document.headers()["content-type"]).toBe("application/pdf");
  });

  it("starts a warranty from a Costco expense with Costco's terms filled", async () => {
    // The path the user actually takes: a Costco purchase is already an
    // expense, and the warranty starts from it.
    await page.goto("/expenses", { waitUntil: "load" });
    await page.getByRole("button", { name: "Receipt" }).click();
    await page.waitForURL(/\/expense\/new$/, { timeout: 10_000 });
    await page.waitForTimeout(200);
    await page.locator("input[list='merchants']").fill("Costco");
    await page.locator("input[type='number']").fill("249.99");
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForURL((url) => url.pathname === "/expenses", {
      timeout: 15_000,
    });

    await page.getByText("Costco", { exact: true }).click();
    await page.waitForURL(/\/expense\/[^/]+$/, { timeout: 10_000 });
    await page.getByRole("link", { name: "Add warranty" }).click();
    await page.waitForURL(/\/warranty\/new\?expenseId=/, { timeout: 10_000 });
    await page.waitForTimeout(200);

    await expect(page.getByLabel("Merchant", { exact: true })).toHaveValue(
      "Costco",
    );
    await expect(page.getByLabel("Terms", { exact: true })).toHaveValue(
      /90 days/,
    );
    // Left unsaved on purpose: the record belongs to the user to create.
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForURL((url) => url.pathname === "/warranties", {
      timeout: 10_000,
    });
  });
});
