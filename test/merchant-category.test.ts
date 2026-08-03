import { describe, it, expect } from "vitest";
import { ulid } from "ulid";
import { resolveCategory } from "~/lib/receipt-ai.server";
import { readMerchantCategories } from "~/lib/store.server";
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
  const byMerchant = new Map([
    ["officemax", "Office Supplies"],
    ["blue bottle coffee", "Meals"],
  ]);
  const existing = ["Office Supplies", "Meals", "Travel", "Software"];

  it("reuses the category a previous expense for the same merchant used", () => {
    expect(resolveCategory("OfficeMax", "Meals", byMerchant, existing)).toBe(
      "Office Supplies",
    );
  });

  it("matches the merchant case- and whitespace-insensitively", () => {
    expect(
      resolveCategory(
        "  BLUE BOTTLE   COFFEE ",
        "Travel",
        byMerchant,
        existing,
      ),
    ).toBe("Meals");
  });

  it("falls back to the suggested category for an unknown merchant", () => {
    expect(resolveCategory("New Cafe", "Meals", byMerchant, existing)).toBe(
      "Meals",
    );
  });

  it("maps the suggestion onto an existing category name", () => {
    // The model said "Office" — the account's closest category wins.
    expect(resolveCategory("New Store", "Office", byMerchant, existing)).toBe(
      "Office Supplies",
    );
  });

  it("returns an empty category when nothing fits", () => {
    expect(
      resolveCategory("New Store", "Rocket Fuel", byMerchant, existing),
    ).toBe("");
  });

  it("guesses from the suggestion when the merchant has no prior category", () => {
    expect(
      resolveCategory("Unknown Merchant", "Software", byMerchant, existing),
    ).toBe("Software");
  });
});

/** The store helper that feeds resolveCategory — reads the seeded rows. */
describe("readMerchantCategories", () => {
  it("returns each merchant's category, keyed by normalized name", async () => {
    const byMerchant = await readMerchantCategories(TEST_ACCOUNT_ID);
    expect(byMerchant.get("officemax")).toBe("Office Supplies");
    expect(byMerchant.get("test store")).toBe("Testing");
    expect(byMerchant.get("devshop")).toBe("Development");
    expect(byMerchant.get("misc")).toBe("Testing");
  });

  it("excludes merchants from other accounts", async () => {
    const byMerchant = await readMerchantCategories(TEST_ACCOUNT_ID);
    // "Secret Corp" belongs to the other account only.
    expect(byMerchant.has("secret corp")).toBe(false);
  });

  it("keeps the most recent category when a merchant was recategorized", async () => {
    const created = [
      {
        id: ulid(),
        accountId: TEST_ACCOUNT_ID,
        type: "receipt" as const,
        date: "2026-06-10",
        report: "2026 Test",
        category: "Office Supplies",
        description: "",
        amount: "9.99",
        merchant: "Recat Store",
        imageFile: "",
        imageMime: "",
        originalName: "",
        locations: [],
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
      },
      {
        id: ulid(),
        accountId: TEST_ACCOUNT_ID,
        type: "receipt" as const,
        date: "2026-06-20",
        report: "2026 Test",
        category: "Testing",
        description: "",
        amount: "19.99",
        merchant: "Recat Store",
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
      const byMerchant = await readMerchantCategories(TEST_ACCOUNT_ID);
      expect(byMerchant.get("recat store")).toBe("Testing");
    } finally {
      await testPrisma.expense.deleteMany({
        where: { accountId: TEST_ACCOUNT_ID, merchant: "Recat Store" },
      });
    }
  });

  it("scopes to the account's own rows", async () => {
    const byMerchant = await readMerchantCategories(OTHER_ACCOUNT_ID);
    // The other account sees its own merchant's category.
    expect(byMerchant.get("secret corp")).toBe("Confidential");
  });
});
