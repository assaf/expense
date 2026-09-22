import { describe, expect, it, vi } from "vite-plus/test";
import { ulid } from "ulid";

/**
 * Two `capture_receipt` calls carrying the same image bytes at the same
 * moment: the pre-check that normally catches a duplicate (`findSameImageExpense`)
 * runs before either insert, so both sail past it and the unique index on
 * (accountId, imageSha256) is the real gate. The loser must drop its stored
 * blob and report the winner as `duplicateOf`, not fail — the branch that
 * makes this safe was untested. The mock only forces the race to reach that
 * branch: the loser's post-conflict lookup still delegates to the real
 * function, because it has to find the row the winner just committed.
 */

const { precheck } = vi.hoisted(() => ({ precheck: { count: 0 } }));

vi.mock("~/lib/db/expenses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/db/expenses")>();
  return {
    ...actual,
    findSameImageExpense: async (accountId: string, sha256: string) => {
      // The two concurrent captures each run the pre-check before either
      // insert; every later call is the loser's post-conflict lookup.
      precheck.count += 1;
      if (precheck.count <= 2) return undefined;
      return actual.findSameImageExpense(accountId, sha256);
    },
  };
});

import sharp from "sharp";
import { captureReceipt, type ToolResult } from "~/lib/mcp-write.server";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("capture_receipt duplicate race", () => {
  it("admits one capture and reports the second as a duplicate", async () => {
    const png = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 3,
        background: { r: 12, g: 34, b: 56 },
      },
    })
      .png()
      .toBuffer();
    const args = (suffix: string) => ({
      imageData: png.toString("base64"),
      mime: "image/png",
      filename: `race-${ulid()}-${suffix}.png`,
      report: "2026 Test",
    });
    const beforeBlobs = await testPrisma.imageBlob.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });

    const [a, b] = await Promise.all([
      captureReceipt(TEST_ACCOUNT_ID, args("a")),
      captureReceipt(TEST_ACCOUNT_ID, args("b")),
    ]);

    const results: Record<string, unknown>[] = [a, b].map((result) => ({
      isError: result.isError ?? false,
      ...payload(result),
    }));
    for (const result of results) expect(result.isError).toBe(false);

    const winners = results.filter((result) => result.captured === true);
    expect(winners).toHaveLength(1);
    const winnerId = winners[0]!.expenseId as string;

    const loser = results.find((result) => result.captured === false)!;
    expect(loser.duplicate).toBe(true);
    expect(loser.duplicateOf).toBe(winnerId);

    const winnerRow = await testPrisma.expense.findFirst({
      where: { id: winnerId, accountId: TEST_ACCOUNT_ID },
    });
    const sha = winnerRow!.imageSha256!;
    expect(
      await testPrisma.expense.count({
        where: { accountId: TEST_ACCOUNT_ID, imageSha256: sha },
      }),
    ).toBe(1);
    // Only the winner's blob survived: the loser deleted its copy.
    expect(
      await testPrisma.imageBlob.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(beforeBlobs + 1);

    await testPrisma.imageBlob.deleteMany({
      where: { accountId: TEST_ACCOUNT_ID, key: winnerRow!.imageFile },
    });
    await testPrisma.expense.deleteMany({ where: { id: winnerId } });
  });
});
