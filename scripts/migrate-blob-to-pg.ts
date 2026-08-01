#!/usr/bin/env node
/**
 * One-off migration: copy receipt images from Vercel Blob into Postgres
 * (image_blobs) so all images live in the database. The app then runs with
 * IMAGE_BACKEND=pg and Vercel Blob is no longer used.
 *
 * Keys are identical on both backends (`images/{accountId}/{name}`), so the
 * copy is a straight key-for-key upsert; re-running is idempotent.
 *
 * Usage:
 *   DATABASE_URL=… BLOB_READ_WRITE_TOKEN=… node scripts/migrate-blob-to-pg.ts
 */
import "dotenv/config";
import { list, get } from "@vercel/blob";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  }),
});

const BLOB_PREFIX = "images";
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
};

function mimeFor(key: string, fallback: string): string {
  const dot = key.lastIndexOf(".");
  const ext = dot === -1 ? "" : key.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? fallback;
}

async function main(): Promise<void> {
  // List every image blob (all accounts).
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: `${BLOB_PREFIX}/`, cursor, limit: 1000 });
    for (const b of page.blobs) keys.push(b.pathname);
    cursor = page.cursor;
  } while (cursor);

  console.info(`Found ${keys.length} image(s) in Vercel Blob`);
  let copied = 0;
  let skipped = 0;

  for (const pathname of keys) {
    // images/{accountId}/{name…}
    const rest = pathname.slice(BLOB_PREFIX.length + 1);
    const slash = rest.indexOf("/");
    if (slash <= 0) {
      console.warn(`  skipping unnamespaced key: ${pathname}`);
      continue;
    }
    const accountId = rest.slice(0, slash);
    const mime = mimeFor(pathname, "image/jpeg");
    const existing = await prisma.imageBlob.findFirst({
      where: { accountId, key: pathname },
      select: { key: true },
    });
    if (existing) {
      skipped++;
      continue;
    }
    const blob = await get(pathname, { access: "public" });
    if (!blob) {
      console.warn(`  missing in Blob: ${pathname}`);
      continue;
    }
    const buffer = Buffer.from(await new Response(blob.stream).arrayBuffer());
    await prisma.imageBlob.upsert({
      where: { accountId_key: { accountId, key: pathname } },
      create: { accountId, key: pathname, mime, data: new Uint8Array(buffer) },
      update: { mime, data: new Uint8Array(buffer) },
    });
    copied++;
    if (copied % 25 === 0) console.info(`  ${copied} copied …`);
  }
  console.info(`Done: ${copied} copied, ${skipped} already present`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
