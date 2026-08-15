import { describe, it, expect, beforeEach, afterAll } from "vitest";
import sharp from "sharp";
import {
  saveImage,
  renameImageToConvention,
  readImage,
} from "~/lib/images.server";
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
  it("coerces a crafted HTML upload to octet-stream (never renderable)", async () => {
    const { filename, mime } = await saveImage(
      TEST_ACCOUNT_ID,
      Buffer.from("<!doctype html><script>alert(1)</script>"),
      "text/html",
      "evil.html",
    );
    createdKeys.push(filename);
    expect(mime).toBe("application/octet-stream");
    const row = await testPrisma.imageBlob.findFirst({
      where: { key: filename },
    });
    expect(row!.mime).toBe("application/octet-stream");
  });

  it("coerces an SVG upload to octet-stream (no script-bearing svg)", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const { filename, mime } = await saveImage(
      TEST_ACCOUNT_ID,
      svg,
      "image/svg+xml",
      "evil.svg",
    );
    createdKeys.push(filename);
    expect(mime).toBe("application/octet-stream");
  });

  it("keeps a legitimate image mime through the store", async () => {
    const png = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();
    const { filename, mime } = await saveImage(
      TEST_ACCOUNT_ID,
      png,
      "image/png",
      "ok.png",
    );
    createdKeys.push(filename);
    expect(mime).toBe("image/jpeg"); // resized + re-encoded
  });
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

  it("passes through bytes it cannot decode (no re-encode crash)", async () => {
    const { filename } = await saveImage(
      TEST_ACCOUNT_ID,
      BUFFER,
      "image/jpeg",
      "receipt.jpg",
    );
    createdKeys.push(filename);
    const image = await readImage(TEST_ACCOUNT_ID, filename);
    expect(image?.buffer.equals(BUFFER)).toBe(true);
    expect(image?.mime).toBe("image/jpeg");
  });

  it("downscales a large image to max 1024px wide and re-encodes as JPEG", async () => {
    const big = await sharp({
      create: {
        width: 2400,
        height: 1800,
        channels: 3,
        background: { r: 250, g: 250, b: 250 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 1200,
              height: 200,
              channels: 3,
              background: { r: 40, g: 40, b: 40 },
            },
          })
            .png()
            .toBuffer(),
          left: 200,
          top: 400,
        },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();
    expect(big.length).toBeGreaterThan(10_000);

    const { filename, mime } = await saveImage(
      TEST_ACCOUNT_ID,
      big,
      "image/jpeg",
      "photo.jpg",
    );
    createdKeys.push(filename);
    expect(mime).toBe("image/jpeg");
    expect(filename.endsWith(".jpg")).toBe(true);

    const image = await readImage(TEST_ACCOUNT_ID, filename);
    expect(image).not.toBeNull();
    const meta = await sharp(image!.buffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeLessThanOrEqual(1024);
    expect(meta.height).toBe(768); // 1800 * 1024/2400
    expect(image!.buffer.length).toBeLessThan(big.length);
  });

  it("keeps an already-small JPEG byte-identical (no generational loss)", async () => {
    const small = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const { filename, mime } = await saveImage(
      TEST_ACCOUNT_ID,
      small,
      "image/jpeg",
      "small.jpg",
    );
    createdKeys.push(filename);
    expect(mime).toBe("image/jpeg");

    const image = await readImage(TEST_ACCOUNT_ID, filename);
    expect(image?.buffer.equals(small)).toBe(true);
  });

  it("converts a large PNG to a 1024px JPEG at save time", async () => {
    const png = await sharp({
      create: {
        width: 2000,
        height: 1400,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();

    const { filename, mime } = await saveImage(
      TEST_ACCOUNT_ID,
      png,
      "image/png",
      "render.png",
    );
    createdKeys.push(filename);
    expect(mime).toBe("image/jpeg");
    expect(filename.endsWith(".jpg")).toBe(true);

    const image = await readImage(TEST_ACCOUNT_ID, filename);
    expect(image).not.toBeNull();
    const meta = await sharp(image!.buffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(717); // 1400 * 1024/2000
  });

  it("converts a TIFF to JPEG at save time", async () => {
    const tiff = await sharp({
      create: {
        width: 120,
        height: 80,
        channels: 3,
        background: { r: 250, g: 250, b: 250 },
      },
    })
      .tiff()
      .toBuffer();

    const { filename, mime } = await saveImage(
      TEST_ACCOUNT_ID,
      tiff,
      "image/tiff",
      "scan.tiff",
    );
    createdKeys.push(filename);
    expect(mime).toBe("image/jpeg");
    expect(filename.endsWith(".jpg")).toBe(true);

    const image = await readImage(TEST_ACCOUNT_ID, filename);
    expect(image).not.toBeNull();
    const meta = await sharp(image!.buffer).metadata();
    expect(meta.format).toBe("jpeg");
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
