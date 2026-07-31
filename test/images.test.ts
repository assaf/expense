import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { saveImage, renameImageToConvention } from "~/lib/images.server";
import {
  testPrisma,
  TEST_ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
} from "./helpers/seedTestData";

/**
 * Image-name uniqueness: every stored image must have a name that does not
 * conflict with an existing image in the database. When the intended name is
 * already taken, the store falls back to a GUID-suffixed alternative instead
 * of overwriting or colliding.
 */

const BUFFER = Buffer.from("fake-receipt-bytes");
const createdKeys: string[] = [];

async function cleanup() {
  await testPrisma.imageBlob.deleteMany({
    where: { key: { in: createdKeys } },
  });
  createdKeys.length = 0;
}

afterAll(cleanup);
beforeEach(cleanup);

describe("saveImage", () => {
  it("saves two images with the same original name under distinct keys", async () => {
    const a = await saveImage(
      TEST_ACCOUNT_ID,
      BUFFER,
      "image/jpeg",
      "receipt.jpg",
    );
    const b = await saveImage(
      TEST_ACCOUNT_ID,
      BUFFER,
      "image/jpeg",
      "receipt.jpg",
    );
    createdKeys.push(a.filename, b.filename);

    expect(a.filename).not.toBe(b.filename);
    for (const key of [a.filename, b.filename]) {
      const row = await testPrisma.imageBlob.findFirst({
        where: { accountId: TEST_ACCOUNT_ID, key },
      });
      expect(row).not.toBeNull();
    }
  });
});

describe("renameImageToConvention", () => {
  it("uses the exact convention name when it is free", async () => {
    const { filename: temp } = await saveImage(
      TEST_ACCOUNT_ID,
      BUFFER,
      "image/jpeg",
      "receipt.jpg",
    );
    const renamed = await renameImageToConvention(
      TEST_ACCOUNT_ID,
      temp,
      "2026-01-15",
      "2026 Test",
      "receipt.jpg",
      "image/jpeg",
    );
    createdKeys.push(temp, renamed);

    expect(renamed).toBe("images/acct_test1/2026-01-15_2026_Test_receipt.jpg");
  });

  it("falls back to a GUID-suffixed name when the convention name is taken", async () => {
    // First image claims the convention name.
    const { filename: tempA } = await saveImage(
      TEST_ACCOUNT_ID,
      BUFFER,
      "image/jpeg",
      "receipt.jpg",
    );
    const nameA = await renameImageToConvention(
      TEST_ACCOUNT_ID,
      tempA,
      "2026-01-15",
      "2026 Test",
      "receipt.jpg",
      "image/jpeg",
    );
    createdKeys.push(tempA, nameA);
    expect(nameA).toBe("images/acct_test1/2026-01-15_2026_Test_receipt.jpg");

    // Second image with the same date/report/original name must get a
    // different, GUID-suffixed name — never a duplicate.
    const { filename: tempB } = await saveImage(
      TEST_ACCOUNT_ID,
      BUFFER,
      "image/jpeg",
      "receipt.jpg",
    );
    const nameB = await renameImageToConvention(
      TEST_ACCOUNT_ID,
      tempB,
      "2026-01-15",
      "2026 Test",
      "receipt.jpg",
      "image/jpeg",
    );
    createdKeys.push(tempB, nameB);

    expect(nameB).not.toBe(nameA);
    expect(nameB).toMatch(
      /^images\/acct_test1\/2026-01-15_2026_Test_receipt-[0-9a-f]{8}\.jpg$/,
    );

    // Both rows exist under distinct keys.
    const rows = await testPrisma.imageBlob.findMany({
      where: { accountId: TEST_ACCOUNT_ID, key: { in: [nameA, nameB] } },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it("does not treat names in other accounts as conflicts", async () => {
    const { filename: temp } = await saveImage(
      OTHER_ACCOUNT_ID,
      BUFFER,
      "image/jpeg",
      "receipt.jpg",
    );
    const renamed = await renameImageToConvention(
      OTHER_ACCOUNT_ID,
      temp,
      "2026-01-15",
      "2026 Test",
      "receipt.jpg",
      "image/jpeg",
    );
    createdKeys.push(temp, renamed);

    // Same bare name as the test account's image, but a different namespace,
    // so no suffix is needed.
    expect(renamed).toBe("images/acct_test2/2026-01-15_2026_Test_receipt.jpg");
  });
});
