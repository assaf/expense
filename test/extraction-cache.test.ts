import { describe, expect, it } from "vitest";
import {
  extractionCacheKey,
  readCachedExtraction,
  writeCachedExtraction,
} from "~/lib/db/extraction-cache";
import type { Prisma } from "prisma/generated";
import type { ExtractionResult } from "~/lib/receipt-ai.server";
import {
  TEST_ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
  testPrisma,
} from "./helpers/seedTestData";

/**
 * The extraction cache: re-uploading the same receipt (retry, a second
 * draft, MCP + web upload of the same file) returns the stored DeepSeek
 * result instead of paying for another call. Keyed by sha256 of the input,
 * scoped per account because category/report suggestions are account-specific.
 */

const result: ExtractionResult = {
  isReceipt: true,
  merchant: "Starbucks",
  description: "",
  amount: "7.25",
  currency: "USD",
  category: "Meals",
  report: "2026 Test",
  confidence: "high",
  notes: "",
};

describe("extractionCacheKey", () => {
  it("hashes the image bytes", () => {
    const key = extractionCacheKey({
      image: { buffer: Buffer.from("receipt-png"), mime: "image/png" },
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the text", () => {
    const key = extractionCacheKey({ text: "MERCHANT: Amazon\nTOTAL: 9.99" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable per input and distinct across inputs", () => {
    const text = "MERCHANT: Amazon\nTOTAL: 9.99";
    expect(extractionCacheKey({ text })).toBe(extractionCacheKey({ text }));
    expect(extractionCacheKey({ text })).not.toBe(
      extractionCacheKey({ text: text + "\n" }),
    );
    expect(extractionCacheKey({ text })).not.toBe(
      extractionCacheKey({
        image: { buffer: Buffer.from(text), mime: "image/png" },
      }),
    );
  });

  it("returns null when there is nothing to key on", () => {
    expect(extractionCacheKey({})).toBeNull();
  });
});

describe("extraction cache store", () => {
  it("returns null before anything is written", async () => {
    const key = extractionCacheKey({ text: "MERCHANT: Amazon" })!;
    expect(await readCachedExtraction(TEST_ACCOUNT_ID, key)).toBeNull();
  });

  it("round-trips a written extraction", async () => {
    const key = extractionCacheKey({ text: "MERCHANT: Amazon\nTOTAL: 9.99" })!;
    await writeCachedExtraction(TEST_ACCOUNT_ID, key, result);
    expect(await readCachedExtraction(TEST_ACCOUNT_ID, key)).toEqual(result);
  });

  it("scopes cached results per account", async () => {
    const key = extractionCacheKey({ text: "MERCHANT: Amazon\nTOTAL: 9.99" })!;
    await writeCachedExtraction(TEST_ACCOUNT_ID, key, result);
    // Same input hash, other account; must not see the cached result.
    expect(await readCachedExtraction(OTHER_ACCOUNT_ID, key)).toBeNull();
  });

  it("treats expired rows as misses and sweeps them", async () => {
    const key = extractionCacheKey({ text: "MERCHANT: Amazon\nTOTAL: 8.88" })!;
    await testPrisma.receiptExtraction.create({
      data: {
        accountId: TEST_ACCOUNT_ID,
        hash: key,
        result: result as unknown as Prisma.InputJsonValue,
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    });
    expect(await readCachedExtraction(TEST_ACCOUNT_ID, key)).toBeNull();
    // The expired row is gone after the read.
    const row = await testPrisma.receiptExtraction.findUnique({
      where: { accountId_hash: { accountId: TEST_ACCOUNT_ID, hash: key } },
    });
    expect(row).toBeNull();
  });
});
