import { createHash } from "node:crypto";
import { z } from "zod";
import { ulid } from "ulid";

import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { asJson, fromIso } from "~/lib/db/wire";
import { withinWindow } from "~/lib/db/shared";
import type { ExtractionResult } from "~/lib/receipt-ai.server";

/**
 * Cache of DeepSeek extraction results keyed by sha256 of the input: the
 * normalized image bytes or the receipt text. Re-uploading the same receipt
 * (retry, a second draft, MCP + web upload of the same file) returns the
 * stored result instead of paying for another LLM call. Account-scoped
 * because category/report suggestions depend on the account's names.
 *
 * The cache wraps only the LLM call (extractReceipt); the known-merchant
 * skip path never touches it. Entries expire after TTL_MS: the read treats
 * stale rows as misses, and each write sweeps the account's expired rows so
 * the table stays small without a cron.
 */
const TTL_MS = 7 * 24 * 3600 * 1000;

/** The stored extraction, checked on the way out: a row written by an older
 * build (or edited by hand) must read as a miss, not as a complete result
 * whose new fields are silently undefined. Typed against the interface so a
 * field added there fails to compile here. */
const extractionResultSchema: z.ZodType<ExtractionResult> = z.object({
  isReceipt: z.boolean(),
  merchant: z.string(),
  description: z.string(),
  amount: z.string(),
  currency: z.string(),
  category: z.string(),
  report: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string(),
});

/** sha256 hex of the cacheable input, or null when there is nothing to key
 * on (no text and no image). */
export function extractionCacheKey(input: {
  text?: string;
  image?: { buffer: Buffer; mime: string };
}): string | null {
  if (input.image) {
    return createHash("sha256")
      .update("img:")
      .update(input.image.buffer)
      .digest("hex");
  }
  if (!input.text) return null;
  return createHash("sha256")
    .update("txt:")
    .update(input.text, "utf8")
    .digest("hex");
}

/** The stored extraction for (accountId, hash) when fresh, else null. */
export async function readCachedExtraction(
  accountId: string,
  hash: string,
): Promise<ExtractionResult | null> {
  const row = await db.orm.public.ReceiptExtraction.where((r) =>
    and(r.accountId.eq(accountId), r.hash.eq(hash)),
  ).first();
  if (!row) return null;
  if (!withinWindow(row.createdAt, TTL_MS)) {
    await db.orm.public.ReceiptExtraction.where((r) =>
      and(r.accountId.eq(accountId), r.hash.eq(hash)),
    )
      .delete()
      .catch(() => {});
    return null;
  }
  const parsed = extractionResultSchema.safeParse(row.result);
  if (!parsed.success) {
    // A row from an older build (or a hand-edited one) reads as a miss: the
    // extraction runs again rather than handing out a result whose fields
    // are missing behind a type that says they are there.
    return null;
  }
  return parsed.data;
}

/** Store (or refresh) the extraction for (accountId, hash). Best-effort:
 * a cache write failure must never fail the extraction itself. */
export async function writeCachedExtraction(
  accountId: string,
  hash: string,
  result: ExtractionResult,
): Promise<void> {
  const json = asJson(result);
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.orm.public.ReceiptExtraction.where((r) =>
      and(
        r.accountId.eq(accountId),
        r.createdAt.lt(fromIso(expiredBefore(now))),
      ),
    ).deleteAll();
    // The (accountId, hash) uniqueness is a unique index, not a
    // constraint upsert's conflictOn can target, so refresh in place and
    // create only when the row is absent.
    const updated = await tx.orm.public.ReceiptExtraction.where((r) =>
      and(r.accountId.eq(accountId), r.hash.eq(hash)),
    ).updateAll({ result: json, createdAt: fromIso(now) });
    if (updated.length === 0) {
      await tx.orm.public.ReceiptExtraction.create({
        id: ulid(),
        accountId,
        hash,
        result: json,
        createdAt: fromIso(now),
      });
    }
  });
}

function expiredBefore(nowIso: string): string {
  return new Date(Date.parse(nowIso) - TTL_MS).toISOString();
}
