import { describe, it, expect } from "vitest";
import { ulid } from "ulid";
import { resolveCategory, type KnownMerchant } from "~/lib/receipt-ai.server";
import { readKnownMerchants } from "~/lib/db/expenses";
import {
  TEST_ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
  testPrisma,
} from "./helpers/seedTestData";

/**
 * New-receipt category resolution: a previous expense for the same merchant
 * sets the category (reused, not re-guessed); without one, the suggested
 * category is mapped onto an existing category name.
 */
describe("resolveCategory", () => {
  const knownMerchants = new Map<string, KnownMerchant>([
    [
      "officemax",
      { display: "OfficeMax", category: "Office Supplies", report: "" },
    ],
    [
      "blue bottle coffee",
      { display: "Blue Bottle Coffee", category: "Meals", report: "" },
    ],
  ]);
  const existing = ["Office Supplies", "Meals", "Travel", "Software"];

  it("reuses the category a previous expense for the same merchant used", () => {
    expect(
      resolveCategory("OfficeMax", "Meals", knownMerchants, existing),
    ).toBe("Office Supplies");
  });

  it("matches the merchant case- and whitespace-insensitively", () => {
    expect(
      resolveCategory(
        "  BLUE BOTTLE   COFFEE ",
        "Travel",
        knownMerchants,
        existing,
      ),
    ).toBe("Meals");
  });

  it("falls back to the suggested category for an unknown merchant", () => {
    expect(resolveCategory("New Cafe", "Meals", knownMerchants, existing)).toBe(
      "Meals",
    );
  });

  it("maps the suggestion onto an existing category name", () => {
    // The model said "Office", so the account's closest category wins.
    expect(
      resolveCategory("New Store", "Office", knownMerchants, existing),
    ).toBe("Office Supplies");
  });

  it("returns an empty category when nothing fits", () => {
    expect(
      resolveCategory("New Store", "Rocket Fuel", knownMerchants, existing),
    ).toBe("");
  });

  it("guesses from the suggestion when the merchant has no prior category", () => {
    expect(
      resolveCategory("Unknown Merchant", "Software", knownMerchants, existing),
    ).toBe("Software");
  });

  it("ignores a known merchant whose stored category is empty", () => {
    const uncategorized = new Map<string, KnownMerchant>([
      ["new shop", { display: "New Shop", category: "", report: "" }],
    ]);
    expect(resolveCategory("New Shop", "Travel", uncategorized, existing)).toBe(
      "Travel",
    );
  });
});

/** The combined merchant map that drives the LLM-skip path and the prior
 * category/report lookups. */
describe("readKnownMerchants", () => {
  it("exposes display name, category, and report per merchant", async () => {
    const known = await readKnownMerchants(TEST_ACCOUNT_ID);
    expect(known.get("test store")).toEqual({
      display: "Test Store",
      category: "Testing",
      report: "2026 Test",
    });
    expect(known.get("officemax")).toEqual({
      display: "OfficeMax",
      category: "Office Supplies",
      report: "2026 Test",
    });
  });

  it("excludes merchants from other accounts", async () => {
    const known = await readKnownMerchants(TEST_ACCOUNT_ID);
    // "Secret Corp" belongs to the other account only.
    expect(known.has("secret corp")).toBe(false);
  });

  it("scopes to the account's own rows", async () => {
    const known = await readKnownMerchants(OTHER_ACCOUNT_ID);
    expect(known.get("secret corp")).toEqual({
      display: "Secret Corp",
      category: "Confidential",
      report: "Private Report",
    });
  });

  it("keeps the newest value per field and the newest display spelling", async () => {
    const created = [
      {
        id: ulid(),
        accountId: TEST_ACCOUNT_ID,
        type: "receipt" as const,
        date: "2026-06-01",
        report: "2026 Test",
        category: "Testing",
        description: "",
        amount: "1.00",
        merchant: "Field Store",
        imageFile: "",
        imageMime: "",
        originalName: "",
        locations: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
      {
        // Newer row: recategorized, no report, different display spelling
        // (normalizes to the same key).
        id: ulid(),
        accountId: TEST_ACCOUNT_ID,
        type: "receipt" as const,
        date: "2026-06-20",
        report: "",
        category: "Office Supplies",
        description: "",
        amount: "2.00",
        merchant: "field  store",
        imageFile: "",
        imageMime: "",
        originalName: "",
        locations: [],
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
    ];
    await testPrisma.expense.createMany({ data: created });
    try {
      const known = await readKnownMerchants(TEST_ACCOUNT_ID);
      // Category: newest non-empty wins. Report: the older row's report is
      // kept because the newer row left it empty. Display: newest spelling.
      expect(known.get("field store")).toEqual({
        display: "field  store",
        category: "Office Supplies",
        report: "2026 Test",
      });
    } finally {
      await testPrisma.expense.deleteMany({
        where: {
          accountId: TEST_ACCOUNT_ID,
          merchant: { in: ["Field Store", "field  store"] },
        },
      });
    }
  });
});
