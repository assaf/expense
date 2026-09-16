import { describe, expect, it } from "vitest";
import { pairRows, SCHEDULE_C_PAGE, scheduleCRows } from "~/lib/content.server";
import { DEFAULT_CATEGORIES } from "~/lib/default-categories.server";

/** The Schedule C reference page claims to list "the categories Expense
 * seeds". The names now come from the CSV the seeder reads, and the notes
 * from app/data/schedule-c-categories.yaml, paired by position, so an edit
 * to either side that drops or adds a row fails loudly here. */
describe("schedule C page data", () => {
  it("gives every seeded category exactly one note", () => {
    expect(SCHEDULE_C_PAGE.notes).toHaveLength(DEFAULT_CATEGORIES.length);
    expect(scheduleCRows().map((row) => row.name)).toEqual(DEFAULT_CATEGORIES);
  });

  it("gives every row a form line and a non-empty note", () => {
    for (const row of scheduleCRows()) {
      expect(row.line).toMatch(/^\d+[ab]?$/);
      expect(row.note.trim()).not.toBe("");
    }
  });
});

describe("pairRows", () => {
  it("pairs names with notes in order", () => {
    expect(
      pairRows(
        ["Advertising", "Utilities"],
        [
          { line: "8", note: "Ads." },
          { line: "25", note: "Phone and power." },
        ],
      ),
    ).toEqual([
      { line: "8", name: "Advertising", note: "Ads." },
      { line: "25", name: "Utilities", note: "Phone and power." },
    ]);
  });

  it("throws when the two lists disagree on length", () => {
    expect(() =>
      pairRows(
        ["Advertising"],
        [
          { line: "8", note: "Ads." },
          { line: "9", note: "More." },
        ],
      ),
    ).toThrow(/2 notes for 1 seeded categories/);
  });
});
