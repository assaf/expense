import { extname } from "node:path";
import { del, get, put, rename as blobRename } from "@vercel/blob";
import { ulid } from "ulid";
import { IMAGE_BACKEND, hasBlob } from "~/lib/env";
import prisma from "~/lib/prisma.server";
import { sanitizeFilenamePart } from "~/lib/validation";

/**
 * Receipt image storage, selected by environment:
 *  1. Vercel Blob under the `images/` prefix when BLOB_READ_WRITE_TOKEN is set
 *     (Vercel production).
 *  2. Postgres BYTEA when IMAGE_BACKEND=pg (dev/tests — no separate service).
 *
 * IMAGE_BACKEND can force either; otherwise Blob token → error. A backend is
 * required: save/read/rename/delete throw a clear error instead of silently
 * falling back to disk.
 *
 * Every key is namespaced per account: `images/{accountId}/{name}`. Two
 * accounts can never collide on the same filename (on either backend), and
 * every read/delete is scoped to the caller's account. Every function takes
 * the owning accountId.
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

export function mimeForFile(filename: string, fallback = ""): string {
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

/**
 * Build the convention filename (bare, no namespace):
 *   {YYYY-MM-DD}_{REPORT}_{FILENAME}.{ext}
 * Returns "" when date, report, or original name is missing — callers keep the
 * temporary name in that case and rename later once the expense is complete.
 */
export function conventionImageName(
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
  const pathname = namespacedKey(accountId, `${ulid()}${ext}`);

  if (backend() === "blob") {
    const blob = await put(pathname, buffer, {
      access: "public",
      contentType: resolvedMime,
      addRandomSuffix: false,
    });
    return { filename: blob.pathname, mime: resolvedMime };
  }

  await prisma.imageBlob.create({
    data: {
      accountId,
      key: pathname,
      mime: resolvedMime,
      data: new Uint8Array(buffer),
    },
  });
  return { filename: pathname, mime: resolvedMime };
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
    let to = namespacedKey(accountId, target);
    if (await blobExists(to)) {
      to = suffixedKey(accountId, target);
    }
    await blobRename(currentFile, to, { access: "public" });
    return to;
  }

  if (!(await pgExists(accountId, currentFile))) return currentFile;
  let to = namespacedKey(accountId, target);
  if (await pgExists(accountId, to)) {
    to = suffixedKey(accountId, target);
  }
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

/** Collision-safe convention key: `<stem>-<6 chars><ext>` (all backends). */
function suffixedKey(accountId: string, target: string): string {
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  return namespacedKey(accountId, `${stem}-${ulid().slice(-6)}${ext}`);
}

async function blobExists(pathname: string): Promise<boolean> {
  const blob = await get(pathname, { access: "public" });
  return blob !== null;
}
