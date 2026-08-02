import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";
import {
  isComplete,
  isReceiptComplete,
  isMileageComplete,
} from "~/lib/completeness";
import {
  formatAmount,
  parseAmount,
  normalizeAmount,
  formatDate,
  mileageMerchant,
  yearOf,
  summarizeByReport,
} from "~/lib/format";
import { extractPdfText } from "~/lib/receipt-ocr.server";
import type { ReceiptExpense, MileageExpense } from "~/lib/types";

const makeReceipt = (
  overrides: Partial<ReceiptExpense> = {},
): ReceiptExpense => ({
  id: "test1",
  type: "receipt",
  date: "2026-01-15",
  report: "2026 Test",
  category: "Testing",
  description: "",
  amount: "42.50",
  merchant: "Test Store",
  imageFile: "receipt.jpg",
  imageMime: "image/jpeg",
  originalName: "receipt.jpg",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

const makeMileage = (
  overrides: Partial<MileageExpense> = {},
): MileageExpense => ({
  id: "test2",
  type: "mileage",
  date: "2026-03-10",
  report: "2026 Test",
  category: "Travel",
  description: "",
  amount: "22.40",
  locations: [
    { address: "A", lat: 34.05, lng: -118.24 },
    { address: "B", lat: 34.06, lng: -118.25 },
  ],
  distanceMiles: "32.00",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

describe("Completeness", () => {
  it("a complete receipt is complete", () => {
    expect(isReceiptComplete(makeReceipt())).toBe(true);
  });

  it("a receipt missing merchant is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ merchant: "" }))).toBe(false);
  });

  it("a receipt with zero amount is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ amount: "0.00" }))).toBe(false);
  });

  it("a receipt missing image is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ imageFile: "" }))).toBe(false);
  });

  it("a zero-amount mileage is incomplete", () => {
    expect(isMileageComplete(makeMileage({ amount: "0.00" }))).toBe(false);
  });

  it("a complete mileage is complete", () => {
    expect(isMileageComplete(makeMileage())).toBe(true);
  });

  it("isComplete dispatches correctly", () => {
    expect(isComplete(makeReceipt())).toBe(true);
    expect(isComplete(makeMileage())).toBe(true);
    expect(isComplete(makeReceipt({ merchant: "" }))).toBe(false);
  });
});

describe("Format helpers", () => {
  it("formats amount as currency", () => {
    expect(formatAmount("42.50")).toBe("$42.50");
    expect(formatAmount("0")).toBe("$0.00");
    expect(formatAmount("")).toBe("—");
  });

  it("parseAmount parses or returns null", () => {
    expect(parseAmount("42.50")).toBe(42.5);
    expect(parseAmount("")).toBe(null);
    expect(parseAmount("abc")).toBe(null);
  });

  it("normalizeAmount rounds to 2 decimals", () => {
    expect(normalizeAmount("42.5")).toBe("42.50");
    expect(normalizeAmount("42.501")).toBe("42.50");
    expect(normalizeAmount("")).toBe("");
  });

  it("formats dates", () => {
    expect(formatDate("2026-01-15")).toContain("Jan");
    expect(formatDate("")).toBe("—");
  });

  it("builds mileage merchant label", () => {
    expect(mileageMerchant("32.00", "0.70")).toBe("32.00 mi @ $0.70 / mi");
  });

  it("gets year from date", () => {
    expect(yearOf("2026-03-10")).toBe("2026");
    expect(yearOf("")).toBe(String(new Date().getFullYear()));
  });

  it("summarizes expenses per report", () => {
    const summary = summarizeByReport([
      makeReceipt({ report: "A", amount: "10.00" }),
      makeReceipt({ report: "A", amount: "5.50" }),
      makeReceipt({ report: "", amount: "3.00" }),
      makeReceipt({ report: "B", amount: "" }),
    ]);
    expect(summary.get("A")).toEqual({ count: 2, total: 15.5 });
    expect(summary.get("B")).toEqual({ count: 1, total: 0 });
    // Expenses without a report are skipped unless the bucket is requested.
    expect(summary.has("Unassigned")).toBe(false);
  });

  it("summarizeByReport can bucket unassigned expenses", () => {
    const summary = summarizeByReport(
      [makeReceipt({ report: "", amount: "3.00" })],
      { includeUnassigned: true },
    );
    expect(summary.get("Unassigned")).toEqual({ count: 1, total: 3 });
  });
});

/** A tiny one-page PDF containing the given text (pdfkit embeds the font). */
function makePdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument();
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.text(text);
    doc.end();
  });
}

/**
 * Real pdfjs text extraction — exercises the main-thread worker setup in
 * receipt-ocr.server.ts (extractPdfText is faked everywhere else, so a
 * broken worker — e.g. "Setting up fake worker failed" on serverless
 * bundles — would go unnoticed).
 */
describe("PDF text extraction", () => {
  it("extracts the text layer via the main-thread worker", async () => {
    const pdf = await makePdf("MERCHANT: Test Store\nTOTAL: 12.34");
    const text = await extractPdfText(pdf);
    expect(text).toContain("MERCHANT: Test Store");
    expect(text).toContain("12.34");
  });
});
