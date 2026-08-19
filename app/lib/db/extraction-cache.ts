import { createHash } from "node:crypto";

import type { Prisma } from "prisma/generated";
import prisma from "~/lib/prisma.server";
import type { ExtractionResult } from "~/lib/receipt-ai.server";

/**
 * Cache of DeepSeek extraction results keyed by sha256 of the input — the
 * normalized image bytes or the receipt text. Re-uploading the same receipt
 * (retry, a second draft, MCP + web upload of the same file) returns the
 * stored result instead of paying for another LLM call. Account-scoped
 * because category/report suggestions depend on the account's names.
 *
 * The cache wraps only the LLM call (extractReceipt); the known-merchant
 * skip path never touches it. Entries expire after TTL_MS — the read treats
 * stale rows as misses, and each write sweeps the account's expired rows so
 * the table stays small without a cron.
 */
const TTL_MS = 7 * 24 * 3600 * 1000;

/** sha256 hex of the cacheable input, or null when there is nothing to key
 * on (no text and no image). */
export function extractionCacheKey(input: {
  text?: string;
  image?: { buffer: Buffer; mime: string };
}): string | null {
  if (input.image) {
    return sha256Hex(Buffer.concat([Buffer.from("img:"), input.image.buffer]));
  }
  if (!input.text) return null;
  return sha256Hex(
    Buffer.concat([Buffer.from("txt:"), Buffer.from(input.text, "utf8")]),
  );
}

/** The stored extraction for (accountId, hash) when fresh, else null. */
export async function readCachedExtraction(
  accountId: string,
  hash: string,
): Promise<ExtractionResult | null> {
  const row = await prisma.receiptExtraction.findUnique({
    where: { accountId_hash: { accountId, hash } },
  });
  if (!row) return null;
  if (Date.now() - Date.parse(row.createdAt) > TTL_MS) {
    await prisma.receiptExtraction
      .delete({ where: { accountId_hash: { accountId, hash } } })
      .catch(() => {});
    return null;
  }
  try {
    return row.result as unknown as ExtractionResult;
  } catch {
    return null;
  }
}

/** Store (or refresh) the extraction for (accountId, hash). Best-effort —
 * a cache write failure must never fail the extraction itself. */
export async function writeCachedExtraction(
  accountId: string,
  hash: string,
  result: ExtractionResult,
): Promise<void> {
  const expiredBefore = new Date(Date.now() - TTL_MS).toISOString();
  await prisma.$transaction([
    prisma.receiptExtraction.deleteMany({
      where: { accountId, createdAt: { lt: expiredBefore } },
    }),
    prisma.receiptExtraction.upsert({
      where: { accountId_hash: { accountId, hash } },
      create: {
        accountId,
        hash,
        result: result as unknown as Prisma.InputJsonValue,
        createdAt: new Date().toISOString(),
      },
      update: {
        result: result as unknown as Prisma.InputJsonValue,
        createdAt: new Date().toISOString(),
      },
    }),
  ]);
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
