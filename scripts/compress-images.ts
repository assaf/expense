/**
 * One-off backfill: re-encode every stored receipt image through the same
 * normalization saveImage now applies (≤1024px wide, EXIF-rotated, flattened,
 * JPEG q85 — see app/lib/image-normalize.ts). Existing blobs were stored raw
 * (multi-megabyte phone photos, full-width PDF renders), so this shrinks the
 * database significantly.
 *
 * Idempotent: already-small JPEGs (and anything undecodable / GIF / SVG)
 * pass through unchanged, so re-running is a no-op.
 *
 * Run against the local dev DB (after `./scripts/clone`) or prod:
 *   pnpm compress:images                 # dev (.env)
 *   pnpm compress:images -- --dry-run    # preview savings, no writes
 *   pnpm compress:images -- --limit 100  # first 100 rows
 *   DATABASE_URL=<prod url> pnpm compress:images   # prod (or .env.prod)
 *
 * Plain Node runs this directly (Node ≥24 type stripping) — no tsx needed.
 * It imports the app's normalize module by relative path to avoid the `~/`
 * alias, which Node does not resolve.
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client.ts";
import {
  normalizeStoredImage,
  STORED_IMAGE_MAX_WIDTH,
  STORED_IMAGE_QUALITY,
} from "../app/lib/image-normalize.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.findIndex((a) => a === "--limit");
const LIMIT =
  LIMIT_ARG >= 0
    ? Number(process.argv[LIMIT_ARG + 1])
    : Number.POSITIVE_INFINITY;
const PAGE_SIZE = 100;
const CONCURRENCY = 4;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not configured — set it in .env / .env.prod",
  );
}

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  max: CONCURRENCY + 1,
  idleTimeoutMillis: 20_000,
  allowExitOnIdle: true,
});
const prisma = new PrismaClient({ adapter, log: ["error"] });

function fmt(bytes: number): string {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
}

async function main(): Promise<void> {
  const total = await prisma.imageBlob.count();
  console.info(
    `[compress-images] ${total} blobs, dry-run=${DRY_RUN}, max width ${STORED_IMAGE_MAX_WIDTH}px, quality ${STORED_IMAGE_QUALITY}`,
  );

  let scanned = 0;
  let changed = 0;
  let before = 0;
  let after = 0;

  const processRow = async (row: {
    accountId: string;
    key: string;
    data: Uint8Array;
  }): Promise<void> => {
    const input = Buffer.from(row.data);
    before += input.length;
    let normalized;
    try {
      normalized = await normalizeStoredImage(input);
    } catch (err) {
      console.error(
        `  ! ${row.accountId}/${row.key}: normalize failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!normalized || normalized.buffer.length === input.length) {
      return; // unchanged (already small JPEG, undecodable, etc.)
    }
    changed++;
    after += normalized.buffer.length;
    console.info(
      `  - ${row.accountId}/${row.key}: ${fmt(input.length)} → ${fmt(normalized.buffer.length)}`,
    );
    if (!DRY_RUN) {
      await prisma.imageBlob.updateMany({
        where: { accountId: row.accountId, key: row.key },
        data: {
          mime: normalized.mime,
          data: new Uint8Array(normalized.buffer),
        },
      });
    }
  };

  for (let skip = 0; ; skip += PAGE_SIZE) {
    if (scanned >= LIMIT) break;
    const rows = await prisma.imageBlob.findMany({
      select: { accountId: true, key: true, data: true },
      skip,
      take: PAGE_SIZE,
    });
    if (rows.length === 0) break;

    // Bound peak memory: run a small concurrent pool over each page.
    let index = 0;
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, rows.length) },
      async () => {
        while (index < rows.length) {
          const row = rows[index++]!;
          if (scanned < LIMIT) {
            scanned++;
            await processRow(row);
          }
        }
      },
    );
    await Promise.all(workers);
  }

  console.info(
    `[compress-images] scanned ${scanned}, changed ${changed}, ` +
      `total ${fmt(before)} → ${fmt(after)} (${after && before ? `${Math.round((1 - after / before) * 100)}% smaller` : "n/a"})` +
      (DRY_RUN ? " — dry run, nothing written" : ""),
  );
}

await main();
await prisma.$disconnect();
