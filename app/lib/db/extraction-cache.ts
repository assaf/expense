import { createHash } from "node:crypto";
import { ulid } from "ulid";

import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { asJson, fromIso, toIso } from "~/lib/db/wire";
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
  if (Date.now() - Date.parse(toIso(row.createdAt)) > TTL_MS) {
    await db.orm.public.ReceiptExtraction.where((r) =>
      and(r.accountId.eq(accountId), r.hash.eq(hash)),
    )
      .delete()
      .catch(() => {});
    return null;
  }
  return row.result as unknown as ExtractionResult;
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
