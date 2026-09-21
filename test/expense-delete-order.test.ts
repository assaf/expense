import { readFileSync } from "node:fs";
import { ulid } from "ulid";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * `deleteExpense` deletes the row before the blob on purpose: a failure in the
 * blob delete then leaves an unreferenced blob (cheap, and nothing sweeps it
 * yet — DRAFT-ORPHAN-1), never a surviving row whose receipt image is already
 * gone. Swapping the two lines is invisible to the happy path, so this drives
 * the failure the ordering exists for. `deleteImages` is best-effort in
 * production; the mock forces the throw the ordering guards against.
 */

const { failDeleteState } = vi.hoisted(() => ({
  failDeleteState: { value: false },
}));

vi.mock("~/lib/images.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/images.server")>();
  return {
    ...actual,
    deleteImages: async (
      ...args: Parameters<typeof actual.deleteImages>
    ): Promise<void> => {
      if (failDeleteState.value) throw new Error("blob exploded");
      return actual.deleteImages(...args);
    },
  };
});

import { deleteExpense, readExpenses, upsertExpense } from "~/lib/db/expenses";
import { readImage, saveImage } from "~/lib/images.server";
import { newExpenseShell, type ReceiptExpense } from "~/lib/types";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

const PNG = readFileSync("test/fixtures/images/blue-bottle.png");

const created: Array<{ id: string; imageFile: string }> = [];

async function createReceiptWithImage(): Promise<{
  id: string;
  imageFile: string;
}> {
  const { filename } = await saveImage(
    TEST_ACCOUNT_ID,
    PNG,
    "image/png",
    `delete-order-${ulid()}.png`,
  );
  const expense: ReceiptExpense = {
    ...(newExpenseShell("receipt") as ReceiptExpense),
    id: ulid(),
    date: "2026-01-15",
    report: "2026 Test",
    category: "Office Supplies",
    description: "",
    amount: "1.00",
    merchant: "Delete Order",
    imageFile: filename,
    imageMime: "image/png",
    originalName: "delete-order.png",
    imageSha256: "",
  };
  await upsertExpense(expense, TEST_ACCOUNT_ID);
  created.push({ id: expense.id, imageFile: filename });
  return { id: expense.id, imageFile: filename };
}

afterAll(async () => {
  for (const { id, imageFile } of created) {
    await testPrisma.expense.deleteMany({ where: { id } });
    await testPrisma.imageBlob.deleteMany({
      where: { accountId: TEST_ACCOUNT_ID, key: imageFile },
    });
  }
});

describe("deleteExpense ordering", () => {
  it("removes the row even when the blob delete fails", async () => {
    const { id, imageFile } = await createReceiptWithImage();
    failDeleteState.value = true;
    try {
      // Whether the blob failure propagates is not the invariant under test;
      // the row must be gone either way.
      await deleteExpense(id, TEST_ACCOUNT_ID).catch(() => {});
      expect(await testPrisma.expense.findFirst({ where: { id } })).toBeNull();
      expect(await readImage(TEST_ACCOUNT_ID, imageFile)).not.toBeNull();
      const rows = await readExpenses(TEST_ACCOUNT_ID);
      expect(rows.some((row) => row.id === id)).toBe(false);
    } finally {
      failDeleteState.value = false;
    }
  });

  it("removes both the row and the blob on the happy path", async () => {
    const { id, imageFile } = await createReceiptWithImage();
    await deleteExpense(id, TEST_ACCOUNT_ID);
    expect(await testPrisma.expense.findFirst({ where: { id } })).toBeNull();
    expect(await readImage(TEST_ACCOUNT_ID, imageFile)).toBeNull();
  });
});
