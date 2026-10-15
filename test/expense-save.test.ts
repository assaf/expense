import { describe, expect, it } from "vite-plus/test";
import { saveExpenseFromForm } from "~/lib/expense-save.server";
import { readExpense } from "~/lib/db/expenses";
import type { Expense } from "~/lib/types";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

/**
 * The save path refuses a category the account does not own. Categories get
 * renamed and merged, so a form — or an editor tab left open across such a
 * change — can post a name that has since gone; stored verbatim it leaves the
 * expense under an orphan: invisible in the category list, absent from the
 * filters, and unmatched by a report.
 */
describe("expense save: category", () => {
  function save(
    fields: Record<string, string>,
    existing: Expense | null = null,
  ) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return saveExpenseFromForm(form, TEST_ACCOUNT_ID, existing);
  }

  /** A row carrying a category the account no longer has, written directly so
   * it bypasses the validator — what `removeCategory`'s "Delete it anyway"
   * leaves behind. */
  async function orphanRow(id: string) {
    const now = "2026-06-01T00:00:00.000Z";
    await testPrisma.expense.create({
      data: {
        id,
        type: "receipt",
        date: "2026-06-01",
        report: "",
        category: "Fuel/Mileage",
        description: "orphaned category",
        amount: "3.00",
        merchant: "",
        imageFile: "",
        imageMime: "",
        originalName: "",
        distanceMiles: null,
        locations: [],
        createdAt: now,
        updatedAt: now,
        accountId: TEST_ACCOUNT_ID,
      },
    });
    // The mapped reader the edit route itself uses. A raw Prisma row exposes
    // the type column as `_type`, so casting one would leave `existing.type`
    // undefined and send the save down the wrong receipt/mileage branch.
    const row = await readExpense(id, TEST_ACCOUNT_ID);
    expect(row?.type).toBe("receipt");
    return row!;
  }

  it("refuses a category the account does not own", async () => {
    const result = await save({
      type: "receipt",
      date: "2026-06-02",
      report: "",
      category: "Fuel/Mileage",
      amount: "12.34",
      description: "stale category",
    });
    expect(result.error).toContain("Fuel/Mileage");
    expect(result.id).toBeNull();
  });

  it("keeps an orphaned category when the save does not change it", async () => {
    // The exemption, mirroring the report's: an expense that already carries a
    // name no row owns must stay savable, or a "delete it anyway" would leave
    // rows nobody can edit.
    const existing = await orphanRow("exp_orphan_kept");
    const result = await save(
      {
        type: "receipt",
        date: "2026-06-01",
        report: "",
        category: "Fuel/Mileage",
        amount: "3.00",
        description: "still orphaned",
      },
      existing,
    );
    expect(result.error).toBeNull();
    const row = await testPrisma.expense.findFirst({
      where: { id: "exp_orphan_kept" },
    });
    expect(row!.category).toBe("Fuel/Mileage");
    expect(row!.description).toBe("still orphaned");
  });

  it("refuses a different unowned category on the same row", async () => {
    const existing = await orphanRow("exp_orphan_changed");
    // Moving it to another name the list does not have is a new claim, not an
    // unchanged value, so the check applies.
    const result = await save(
      {
        type: "receipt",
        date: "2026-06-01",
        report: "",
        category: "Another Ghost",
        amount: "3.00",
        description: "changed to a ghost",
      },
      existing,
    );
    expect(result.error).toContain("Another Ghost");
    expect(result.id).toBeNull();
  });

  it("saves an owned category, and no category at all", async () => {
    const owned = await save({
      type: "receipt",
      date: "2026-06-03",
      report: "",
      category: "Development",
      amount: "1.00",
      description: "owned category",
    });
    expect(owned.error).toBeNull();
    const ownedRow = await testPrisma.expense.findFirst({
      where: { id: owned.id as string, accountId: TEST_ACCOUNT_ID },
    });
    expect(ownedRow!.category).toBe("Development");

    // An expense with no category is still a perfectly good expense.
    const none = await save({
      type: "receipt",
      date: "2026-06-04",
      report: "",
      category: "",
      amount: "2.00",
      description: "no category",
    });
    expect(none.error).toBeNull();
    const noneRow = await testPrisma.expense.findFirst({
      where: { id: none.id as string, accountId: TEST_ACCOUNT_ID },
    });
    expect(noneRow!.category).toBe("");
  });
});
