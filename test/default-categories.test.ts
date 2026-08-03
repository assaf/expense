import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORIES } from "~/lib/default-categories.server";

/**
 * Canonical default categories. These mirror the expense categories on IRS
 * Schedule C (Form 1040), Part II, lines 8–27a, and must match
 * `app/data/default-categories.csv` exactly, in order.
 *
 * The CSV is the source of truth for what new accounts get seeded with; this
 * pinned list is the drift guard. When intentionally changing the defaults,
 * update this list in the same commit as the CSV so the change is explicit.
 */
const CANONICAL_DEFAULT_CATEGORIES: string[] = [
  "Advertising",
  "Car and truck expenses",
  "Commissions and fees",
  "Contract labor",
  "Depletion",
  "Depreciation and section 179 expense deduction",
  "Employee benefit programs",
  "Insurance (other than health)",
  "Mortgage interest paid to banks, etc.",
  "Other interest",
  "Legal and professional services",
  "Office expenses",
  "Pension and profit-sharing plans",
  "Rent or lease: vehicles, machinery, and equipment",
  "Rent or lease: other business property",
  "Repairs and maintenance",
  "Supplies",
  "Taxes and licenses",
  "Travel",
  "Meals and entertainment",
  "Utilities",
  "Wages",
  "Other expenses",
];

describe("default categories", () => {
  it("matches the pinned IRS Schedule C list", () => {
    expect(DEFAULT_CATEGORIES).toEqual(CANONICAL_DEFAULT_CATEGORIES);
  });

  it("is a clean list with unique, non-blank names", () => {
    expect(DEFAULT_CATEGORIES.length).toBeGreaterThan(0);
    expect(DEFAULT_CATEGORIES.every((name) => name.trim() === name)).toBe(true);
    expect(new Set(DEFAULT_CATEGORIES).size).toBe(DEFAULT_CATEGORIES.length);
  });
});
