import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORIES } from "~/lib/default-categories.server";
import { SCHEDULE_C_ROWS } from "~/lib/seo-content";

/** The Schedule C reference page claims to list "the categories Expense
 * seeds". This pins the page data to the CSV the seeder actually reads, in
 * order, so editing the CSV without updating the page (or the reverse)
 * fails loudly. */
describe("schedule C page data", () => {
  it("lists exactly the seeded default categories, in CSV order", () => {
    expect(SCHEDULE_C_ROWS.map((r) => r.name)).toEqual(DEFAULT_CATEGORIES);
  });

  it("gives every row a form line and a non-empty note", () => {
    for (const row of SCHEDULE_C_ROWS) {
      expect(row.line).toMatch(/^\d+[ab]?$/);
      expect(row.note.trim()).not.toBe("");
    }
  });
});
