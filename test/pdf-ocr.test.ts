import { describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import {
  extractPdfText,
  ocrImage,
  renderPdfToPng,
} from "~/lib/receipt-ocr.server";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A tiny one-page LETTER PDF containing the given text (pdfkit embeds the font). */
function makePdf(text: string, size = 12): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ size: "LETTER" });
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(size).text(text);
    doc.end();
  });
}

/**
 * Real pdfjs text extraction, exercising the main-thread worker setup in
 * receipt-ocr.server.ts (extractPdfText is faked everywhere else, so a
 * broken worker, e.g. "Setting up fake worker failed" on serverless
 * bundles, would go unnoticed).
 */
describe("PDF text extraction", () => {
  it("extracts the text layer via the main-thread worker", async () => {
    const pdf = await makePdf("MERCHANT: Test Store\nTOTAL: 12.34");
    const text = await extractPdfText(pdf);
    expect(text).toContain("MERCHANT: Test Store");
    expect(text).toContain("12.34");
  });
});

/**
 * Real pdfjs rasterization: render the PDF pages to a stacked PNG (the path
 * the receipt pipeline uses for scanned PDFs and stored images).
 */
describe("PDF rasterization", () => {
  it("renders a pdfkit PDF to a valid PNG at 2x the page size", async () => {
    const pdf = await makePdf("MERCHANT: Test Store\nTOTAL: 12.34");
    const png = await renderPdfToPng(pdf);
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
    // LETTER is 612x792pt; renderPdfToPng rasterizes at scale 2 (single
    // page → width 1224) and outputs a non-trivial raster.
    expect(png.readUInt32BE(16)).toBe(1224); // IHDR width
    expect(png.readUInt32BE(20)).toBe(1584); // IHDR height
    expect(png.length).toBeGreaterThan(10_000);
  });
});

/**
 * Full round-trip with the app's real OCR function (ocrImage): render a PDF
 * to PNG, then tesseract the raster and check the text comes back. This is
 * the same chain the smoke endpoint (/api/smoke) runs on every deploy.
 *
 * Skipped unless RUN_OCR_TESTS=1: tesseract downloads eng.traineddata from a
 * CDN on first run (network + a few seconds), so it's opt-in locally and
 * enabled in CI (.github/workflows/deployment-smoke.yml).
 */
describe.skipIf(!process.env.RUN_OCR_TESTS)(
  "OCR round-trip (RUN_OCR_TESTS)",
  () => {
    it("OCRs a pdfjs-rasterized receipt PDF with tesseract", async () => {
      const pdf = await makePdf("SMOKE RECEIPT TOTAL $12.34", 40);
      const png = await renderPdfToPng(pdf);
      const text = (await ocrImage(png)).toUpperCase();
      const norm = text.replace(/[^A-Z0-9]/g, "");
      expect(norm).toContain("SMOKE");
      expect(norm).toContain("RECEIPT");
      expect(norm).toContain("1234");
    }, 120_000);
  },
);
