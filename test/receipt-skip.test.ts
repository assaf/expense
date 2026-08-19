import { describe, expect, it } from "vitest";
import {
  matchKnownMerchant,
  parseReceiptAmount,
  tryKnownMerchantExtraction,
  type KnownMerchant,
} from "~/lib/receipt-ai.server";

/**
 * The LLM-skip path: receipt text naming a merchant the account already
 * spent with, plus a parseable total, extracts without any model call —
 * merchant/category/report come from the account's history, the amount is
 * parsed deterministically. These tests pin the matching and parsing rules
 * so a skip never fires on text it can't read correctly (false merchant or
 * wrong amount are worse than paying for the call).
 */

const known: ReadonlyMap<string, KnownMerchant> = new Map([
  [
    "starbucks",
    { display: "Starbucks", category: "Meals", report: "2026 Test" },
  ],
  [
    "blue bottle coffee",
    { display: "Blue Bottle Coffee", category: "Meals", report: "" },
  ],
  ["uber", { display: "Uber", category: "Travel", report: "2026 Test" }],
  [
    "uber eats",
    { display: "Uber Eats", category: "Meals", report: "2026 Test" },
  ],
  ["amc", { display: "AMC", category: "Entertainment", report: "" }],
]);

describe("matchKnownMerchant", () => {
  it("returns null for empty text or an empty map", () => {
    expect(matchKnownMerchant("", known)).toBeNull();
    expect(matchKnownMerchant("anything", new Map())).toBeNull();
  });

  it("matches a known merchant name inside receipt text", () => {
    const m = matchKnownMerchant(
      "THANK YOU FOR SHOPPING AT STARBUCKS\nTOTAL $7.25",
      known,
    );
    expect(m?.display).toBe("Starbucks");
  });

  it("matches case- and whitespace-insensitively (line breaks inside a name)", () => {
    const m = matchKnownMerchant(
      "Blue Bottle\nCoffee #42\nTOTAL $12.50",
      known,
    );
    expect(m?.display).toBe("Blue Bottle Coffee");
  });

  it("does not match inside another word", () => {
    // "amc" is a known merchant but must not fire on "CAMCORDER".
    expect(matchKnownMerchant("CAMCORDER $299.00", known)).toBeNull();
    expect(matchKnownMerchant("AMC 8:30 PM $15.00", known)?.display).toBe(
      "AMC",
    );
  });

  it("picks the longest (most specific) matching merchant", () => {
    const m = matchKnownMerchant("Your Uber Eats order\nTOTAL $23.40", known);
    // Both "uber" and "uber eats" appear — the longer name wins.
    expect(m?.display).toBe("Uber Eats");
  });
});

describe("parseReceiptAmount", () => {
  it("prefers an explicit total line with a currency symbol", () => {
    expect(
      parseReceiptAmount("Subtotal $38.00\nTax $4.50\nTOTAL $42.50"),
    ).toEqual({ amount: "42.50", currency: "USD" });
  });

  it("accepts a bare total line (no symbol)", () => {
    expect(parseReceiptAmount("Items: 3\nTOTAL: 42.50")).toEqual({
      amount: "42.50",
      currency: "USD",
    });
  });

  it("reads a trailing symbol on a bare total line", () => {
    expect(parseReceiptAmount("TOTAL: 12.50 €")).toEqual({
      amount: "12.50",
      currency: "EUR",
    });
  });

  it("handles comma-decimal (EU) totals", () => {
    // Dot-thousands + comma-decimal.
    expect(parseReceiptAmount("TOTAL: 1.234,56 €")).toEqual({
      amount: "1234.56",
      currency: "EUR",
    });
    // Plain comma-decimal with a leading symbol.
    expect(parseReceiptAmount("Gesamtbetrag € 12,50")).toEqual({
      amount: "12.50",
      currency: "EUR",
    });
    // Bare comma-decimal defaults to USD.
    expect(parseReceiptAmount("TOTAL: 12,50")).toEqual({
      amount: "12.50",
      currency: "USD",
    });
    // ISO code after the number.
    expect(parseReceiptAmount("TOTAL EUR 12,50")).toEqual({
      amount: "12.50",
      currency: "EUR",
    });
  });

  it("picks the amount closest to the total keyword on a mixed line", () => {
    expect(parseReceiptAmount("Subtotal: $38.00 — TOTAL: $42.50")).toEqual({
      amount: "42.50",
      currency: "USD",
    });
  });

  it("falls back to the last symbol amount when no total line exists", () => {
    expect(parseReceiptAmount("Coffee $4.50\nBagel $6.00")).toEqual({
      amount: "6.00",
      currency: "USD",
    });
  });

  it("ignores tip suggestions and change after the total", () => {
    expect(
      parseReceiptAmount(
        "Subtotal $40.00\nTOTAL $47.50\nSuggested Tip: $7.12 $8.55 $9.97\nChange Due $0.00",
      ),
    ).toEqual({ amount: "47.50", currency: "USD" });
    // No total line: tip/change lines must not supply the amount either.
    expect(
      parseReceiptAmount("Coffee $5.00\nSuggested Tip: $0.75 $1.00"),
    ).toEqual({ amount: "5.00", currency: "USD" });
  });

  it("returns null for refunds (negative totals) and symbol-less text", () => {
    expect(parseReceiptAmount("TOTAL: -20.00")).toBeNull();
    expect(parseReceiptAmount("no amounts here at all")).toBeNull();
    expect(parseReceiptAmount("")).toBeNull();
  });
});

describe("tryKnownMerchantExtraction", () => {
  it("extracts a known merchant without any model call", () => {
    const result = tryKnownMerchantExtraction(
      "STARBUCKS #1042\nCaffe Latte $6.75\nTOTAL $7.25",
      known,
    );
    expect(result).toEqual({
      isReceipt: true,
      merchant: "Starbucks",
      description: "",
      amount: "7.25",
      currency: "USD",
      category: "Meals",
      report: "2026 Test",
      confidence: "high",
      notes: "",
    });
  });

  it("returns null when the merchant is known but no amount parses", () => {
    expect(tryKnownMerchantExtraction("STARBUCKS RECEIPT", known)).toBeNull();
  });

  it("returns null for an unknown merchant with a total", () => {
    expect(
      tryKnownMerchantExtraction("NEW SHOP\nTOTAL $9.99", known),
    ).toBeNull();
  });

  it("returns null when a partial match is not word-bounded", () => {
    expect(
      tryKnownMerchantExtraction("CAMCORDER SPECIAL\nTOTAL $299.00", known),
    ).toBeNull();
  });
});
