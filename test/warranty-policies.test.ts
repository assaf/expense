import { describe, expect, it } from "vite-plus/test";
import {
  MERCHANT_POLICIES,
  merchantPolicy,
  policyTermsText,
  termsForMerchant,
} from "~/lib/warranty-policies";

/**
 * The curated merchant coverage table: what it matches, what every entry has
 * to carry to be worth filing, and the text a record ends up with. Entries
 * are domain data, so the invariants below are what keeps a new one honest
 * (a policy with no source or no checked date must not ship).
 */
describe("merchant coverage policies", () => {
  it("matches a merchant name however it is spelled in the record", () => {
    for (const spelled of [
      "Costco",
      "costco",
      "COSTCO #1234",
      "Costco Wholesale",
      "  Costco   Wholesale ",
    ]) {
      expect(merchantPolicy(spelled)?.merchant, spelled).toBe("Costco");
    }
    for (const spelled of ["Sam's Club", "Sams Club #412", "SAM'S CLUB"]) {
      expect(merchantPolicy(spelled)?.merchant, spelled).toBe("Sam's Club");
    }
    expect(merchantPolicy("Best Buy #233")?.merchant).toBe("Best Buy");
    expect(merchantPolicy("The Home Depot")?.merchant).toBe("Home Depot");
    expect(merchantPolicy("IKEA Burbank")?.merchant).toBe("IKEA");
    expect(merchantPolicy("Apple Inc.")?.merchant).toBe("Apple");
    expect(merchantPolicy("Amazon.com")?.merchant).toBe("Amazon");
    expect(merchantPolicy("Walmart Supercenter")?.merchant).toBe("Walmart");
    expect(merchantPolicy("Target #1234")?.merchant).toBe("Target");
    expect(merchantPolicy("Lowe's of Burbank")?.merchant).toBe("Lowe's");
    expect(merchantPolicy("REI Co-op")?.merchant).toBe("REI");
    expect(merchantPolicy("Mattress Firm #42")?.merchant).toBe("Mattress Firm");
  });

  it("lets a specific entry win over the general one it extends", () => {
    // Both keys match "Costco Tire Center"; the longer one wins.
    expect(merchantPolicy("Costco Tire Center")?.merchant).toBe("Costco Tire");
    expect(merchantPolicy("Costco Wholesale")?.merchant).toBe("Costco");
  });

  it("matches an entry under the name the retailer trades under", () => {
    // Discount Tire trades as America's Tire in California.
    expect(merchantPolicy("America's Tire")?.merchant).toBe("Discount Tire");
    expect(merchantPolicy("Americas Tire #12")?.merchant).toBe("Discount Tire");
  });

  it("does not match a longer word that contains a merchant name", () => {
    // All of these would answer yes on a substring match.
    for (const notAMerchant of [
      "mycostco",
      "costcowholesale",
      "Applebee's",
      "applesauce",
      "Pineapple",
      "Amazonia",
      "IKEAbox",
      "REIT",
      "Targets",
      "Lowell",
      "Tire Rack",
      "",
    ]) {
      expect(merchantPolicy(notAMerchant), notAMerchant).toBeUndefined();
    }
  });

  it("gives every entry a summary, a source, and the month it was checked", () => {
    for (const policy of MERCHANT_POLICIES) {
      expect(policy.merchant.trim()).toBe(policy.merchant);
      expect(policy.terms.length).toBeGreaterThan(60);
      // The framing that keeps a record from reading as the app's own claim.
      // A name already ending in "s" (Lowe's) takes the name-then-space form.
      const framing = [
        `${policy.merchant}'s own coverage:`,
        `${policy.merchant} own coverage:`,
      ];
      expect(
        framing.some((prefix) => policy.terms.startsWith(prefix)),
        policy.merchant,
      ).toBe(true);
      expect(policy.sources.length).toBeGreaterThan(0);
      for (const source of policy.sources) {
        expect(source.startsWith("https://")).toBe(true);
      }
      expect(policy.asOf).toMatch(/^\d{4}-\d{2}$/);
      // An alias is only worth carrying if it actually reaches this entry.
      for (const alias of policy.aliases ?? []) {
        expect(alias.trim(), alias).toBe(alias);
        expect(merchantPolicy(alias)?.merchant, alias).toBe(policy.merchant);
      }
    }
  });

  it("files the summary with its provenance", () => {
    const text = termsForMerchant("Costco");
    // The facts a Costco record needs, read from the retailer's own policy
    // documents rather than paraphrased from a summary of them.
    expect(text).toContain("Risk-Free 100% Satisfaction Guarantee");
    expect(text).toContain("90 days");
    expect(text).toContain("up to 2 years");
    expect(text).toContain("at Costco's choosing");
    // Where it came from and when it was checked travel with it.
    expect(text).toContain("/app/answers/detail/a_id/1191");
    expect(text).toContain("checked 2026-09");
    expect(text).toBe(policyTermsText(merchantPolicy("Costco")!));
    // A merchant with no curated policy files no terms of its own.
    expect(termsForMerchant("Blue Bottle")).toBe("");
    expect(termsForMerchant("")).toBe("");
  });
});
