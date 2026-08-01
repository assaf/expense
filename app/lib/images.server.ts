import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { del, get, put, rename as blobRename } from "@vercel/blob";
import { ulid } from "ulid";
import { Prisma } from "prisma/generated";
import { IMAGE_BACKEND, hasBlob } from "~/lib/env";
import prisma from "~/lib/prisma.server";
import { sanitizeFilenamePart } from "~/lib/validation";

/**
 * Receipt image storage, selected by environment:
 *  1. Postgres BYTEA when IMAGE_BACKEND=pg (prod and dev/tests — no separate
 *     service; the image_blobs table is the only store in use today).
 *  2. Vercel Blob under the `images/` prefix when BLOB_READ_WRITE_TOKEN is
 *     set (legacy path, kept for portability).
 *
 * IMAGE_BACKEND can force either; otherwise Blob token → error. A backend is
 * required: save/read/rename/delete throw a clear error instead of silently
 * falling back to disk.
 *
 * Every key is namespaced per account: `images/{accountId}/{name}`. Two
 * accounts can never collide on the same filename (on either backend), and
 * every read/delete is scoped to the caller's account. Every function takes
 * the owning accountId.
 *
 * Names are unique at write time: if an intended name is already taken,
 * `saveImage` / `renameImageToConvention` fall back to a GUID-suffixed
 * alternative instead of overwriting or colliding.
 */

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

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/heic": ".heic",
};

function mimeForFile(filename: string, fallback = ""): string {
  const ext = extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] ?? fallback;
}

function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? "";
}

/** Build a namespaced key: `images/{accountId}/{name}`. */
function namespacedKey(accountId: string, name: string): string {
  return `${BLOB_PREFIX}/${accountId}/${name}`;
}

/** Strip the account namespace from a stored key (for comparisons). */
function bareName(storedKey: string, accountId: string): string {
  const prefix = `${BLOB_PREFIX}/${accountId}/`;
  return storedKey.startsWith(prefix)
    ? storedKey.slice(prefix.length)
    : storedKey;
}

type Backend = "blob" | "pg";

function backend(): Backend {
  if (IMAGE_BACKEND) {
    if (IMAGE_BACKEND === "blob" || IMAGE_BACKEND === "pg") {
      return IMAGE_BACKEND;
    }
    throw new Error(
      `Unknown IMAGE_BACKEND "${IMAGE_BACKEND}" — expected "blob" or "pg".`,
    );
  }
  if (hasBlob()) return "blob";
  throw new Error(
    "No image storage configured — set BLOB_READ_WRITE_TOKEN or IMAGE_BACKEND=pg.",
  );
}

async function pgExists(accountId: string, key: string): Promise<boolean> {
  const row = await prisma.imageBlob.findFirst({
    where: { accountId, key },
    select: { key: true },
  });
  return row !== null;
}

/** How many GUID-suffixed candidates to try before using a full GUID. */
const MAX_NAME_ATTEMPTS = 6;

/**
 * Return a name for the account namespace that is not already taken,
 * preferring `baseName` but switching to GUID-suffixed alternatives when it
 * collides with an existing image. The exact name is unimportant — only that
 * it never conflicts.
 */
async function uniqueName(
  accountId: string,
  baseName: string,
  exists: (key: string) => Promise<boolean>,
): Promise<string> {
  const ext = extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const candidate =
      attempt === 0 ? baseName : `${stem}-${randomUUID().slice(0, 8)}${ext}`;
    if (!(await exists(namespacedKey(accountId, candidate)))) return candidate;
  }
  return `${stem}-${randomUUID()}${ext}`;
}

/**
 * Build the convention filename (bare, no namespace):
 *   {YYYY-MM-DD}_{REPORT}_{FILENAME}.{ext}
 * Returns "" when date, report, or original name is missing — callers keep the
 * temporary name in that case and rename later once the expense is complete.
 */
function conventionImageName(
  date: string,
  report: string,
  originalName: string,
  mime: string,
): string {
  if (!date || !report || !originalName) return "";
  const ext = extname(originalName).toLowerCase() || extForMime(mime);
  const filePart = sanitizeFilenamePart(
    originalName.slice(0, originalName.length - extname(originalName).length),
  );
  const reportPart = sanitizeFilenamePart(report);
  const datePart = sanitizeFilenamePart(date);
  const name = `${datePart}_${reportPart}_${filePart}${ext}`;
  return name || "";
}

/**
 * Persist an uploaded image buffer under a temporary (id-based) key in the
 * account's namespace. Returns the storage key written and the mime type.
 */
export async function saveImage(
  accountId: string,
  buffer: Buffer,
  mime: string,
  originalName: string,
): Promise<{ filename: string; mime: string }> {
  const resolvedMime = mime || mimeForFile(originalName) || "image/png";
  const ext =
    extname(originalName).toLowerCase() || extForMime(resolvedMime) || ".png";

  if (backend() === "blob") {
    const name = await uniqueName(accountId, `${ulid()}${ext}`, blobExists);
    const pathname = namespacedKey(accountId, name);
    const blob = await put(pathname, buffer, {
      access: "public",
      contentType: resolvedMime,
      addRandomSuffix: false,
    });
    return { filename: blob.pathname, mime: resolvedMime };
  }

  // Postgres: `(accountId, key)` is the primary key, so the database itself
  // rejects a duplicate name. Pick a free one first, and retry with a fresh
  // GUID if a concurrent write wins the check-then-write race.
  const base = `${ulid()}${ext}`;
  let name = await uniqueName(accountId, base, (key) =>
    pgExists(accountId, key),
  );
  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.imageBlob.create({
        data: {
          accountId,
          key: namespacedKey(accountId, name),
          mime: resolvedMime,
          data: new Uint8Array(buffer),
        },
      });
      return { filename: namespacedKey(accountId, name), mime: resolvedMime };
    } catch (error) {
      const isDuplicate =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";
      if (!isDuplicate || attempt >= MAX_NAME_ATTEMPTS) throw error;
      name = `${randomUUID()}${ext}`;
    }
  }
}

/**
 * Rename an image to its convention name (if the expense now has a
 * date + report + original name). Returns the (possibly unchanged) key.
 */
export async function renameImageToConvention(
  accountId: string,
  currentFile: string,
  date: string,
  report: string,
  originalName: string,
  mime: string,
): Promise<string> {
  const target = conventionImageName(date, report, originalName, mime);
  const currentBare = bareName(currentFile, accountId);
  if (!target || target === currentBare) return currentFile;

  if (backend() === "blob") {
    if (!(await blobExists(currentFile))) return currentFile;
    const name = await uniqueName(accountId, target, blobExists);
    const to = namespacedKey(accountId, name);
    await blobRename(currentFile, to, { access: "public" });
    return to;
  }

  if (!(await pgExists(accountId, currentFile))) return currentFile;
  const name = await uniqueName(accountId, target, (key) =>
    pgExists(accountId, key),
  );
  const to = namespacedKey(accountId, name);
  await prisma.imageBlob.updateMany({
    where: { accountId, key: currentFile },
    data: { key: to },
  });
  return to;
}

export async function readImage(
  accountId: string,
  filename: string,
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (!filename) return null;

  if (backend() === "blob") {
    const result = await get(filename, { access: "public" });
    if (!result) return null;
    const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
    return { buffer, mime: result.blob.contentType ?? mimeForFile(filename) };
  }

  const row = await prisma.imageBlob.findFirst({
    where: { accountId, key: filename },
    select: { data: true, mime: true },
  });
  if (!row) return null;
  return {
    buffer: Buffer.from(row.data),
    mime: row.mime || mimeForFile(filename),
  };
}

export async function deleteImage(
  accountId: string,
  filename: string,
): Promise<void> {
  if (!filename) return;
  if (backend() === "blob") {
    await del(filename).catch(() => {});
    return;
  }
  await prisma.imageBlob
    .deleteMany({ where: { accountId, key: filename } })
    .catch(() => {});
}

async function blobExists(pathname: string): Promise<boolean> {
  const blob = await get(pathname, { access: "public" });
  return blob !== null;
}
