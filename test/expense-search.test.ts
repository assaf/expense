import { describe, expect, it } from "vitest";
import {
  matchesSearch,
  parseQuery,
  type SearchableExpense,
} from "~/lib/expense-search";

function row(overrides: Partial<SearchableExpense> = {}): SearchableExpense {
  return {
    type: "receipt",
    merchant: "Blue Bottle",
    mileageType: "business",
    locations: [],
    description: "Team offsite coffee",
    category: "Meals",
    amount: "7.50",
    report: "2026 Business",
    ...overrides,
  };
}

describe("parseQuery", () => {
  it("runs an operator's value until the next operator, not the next word", () => {
    // Free text only exists before the first operator: afterwards every
    // word belongs to the active operator (report:2026 Business = one
    // value "2026 business").
    const { filters, words } = parseQuery("blue report:2026 Business");
    expect(words).toEqual(["blue"]);
    expect(filters.report).toEqual(["2026 business"]);
  });
  it("ORs same-key values and starts a new group per key", () => {
    const { filters } = parseQuery(
      "category:meals category:software report:2026",
    );
    expect(filters.category).toEqual(["meals", "software"]);
    expect(filters.report).toEqual(["2026"]);
  });

  it("treats unknown prefixes and bare colons as free text", () => {
    const { filters, words } = parseQuery("foo:bar 10:30");
    expect(filters.report).toEqual([]);
    expect(filters.category).toEqual([]);
    expect(filters.merchant).toEqual([]);
    expect(filters.description).toEqual([]);
    expect(words).toEqual(["foo:bar", "10:30"]);
  });

  it("leaves a valueless operator a no-op unless words follow it", () => {
    expect(parseQuery("report:").filters.report).toEqual([]);
    expect(parseQuery("report: description:x").filters.report).toEqual([]);
    // Words after a valueless operator join it as its value, so this
    // filters report === "coffee" rather than free-text matching "coffee".
    expect(parseQuery("report: coffee").filters.report).toEqual(["coffee"]);
  });
});

describe("matchesSearch", () => {
  const parsed = (query: string) => parseQuery(query);

  it("free text matches merchant, description, category, and the $amount", () => {
    const e = row();
    expect(matchesSearch(e, parsed("blue bottle"))).toBe(true);
    expect(matchesSearch(e, parsed("offsite"))).toBe(true);
    expect(matchesSearch(e, parsed("meals"))).toBe(true);
    expect(matchesSearch(e, parsed("$7"))).toBe(true);
    expect(matchesSearch(e, parsed("$8"))).toBe(false);
    expect(matchesSearch(e, parsed("bluebench"))).toBe(false);
  });

  it("searches mileage rows by type label and route addresses", () => {
    const e = row({
      type: "mileage",
      merchant: "Business mileage",
      locations: [{ address: "1200 Doncat Avenue" }],
      description: "",
      amount: "4.20",
    });
    expect(matchesSearch(e, parsed("business mileage"))).toBe(true);
    expect(matchesSearch(e, parsed("doncat"))).toBe(true);
    expect(matchesSearch(e, parsed("blue bottle"))).toBe(false);
  });

  it("filters report, category, and merchant exactly; description as a substring", () => {
    const e = row();
    expect(matchesSearch(e, parsed("report:2026 business"))).toBe(true);
    expect(matchesSearch(e, parsed("report:2025"))).toBe(false);
    expect(matchesSearch(e, parsed("merchant:blue bottle"))).toBe(true);
    expect(matchesSearch(e, parsed("merchant:blue"))).toBe(false);
    expect(matchesSearch(e, parsed("description:offsite"))).toBe(true);
    expect(matchesSearch(e, parsed("description:meetings"))).toBe(false);
  });

  it("ANDs across keys and ORs within one", () => {
    const e = row();
    expect(
      matchesSearch(
        e,
        parsed("category:meals category:office report:2026 business"),
      ),
    ).toBe(true);
    expect(matchesSearch(e, parsed("category:meals report:2025"))).toBe(false);
  });

  it("matches every row on an empty query", () => {
    expect(matchesSearch(row(), parsed(""))).toBe(true);
  });
});
