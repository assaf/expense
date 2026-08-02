import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { ulid } from "ulid";
import { Prisma } from "prisma/generated";
import prisma from "~/lib/prisma.server";
import { normalizeStoredImage } from "~/lib/image-normalize";
import { sanitizeFilenamePart } from "~/lib/validation";

/**
 * Receipt image storage — Postgres BYTEA only (`image_blobs` table). No
 * external storage service; every image lives in the database.
 *
 * Every key is namespaced per account: `images/{accountId}/{name}`. Two
 * accounts can never collide on the same filename, and every read/delete is
 * scoped to the caller's account. Every function takes the owning accountId.
 *
 * Names are unique at write time: if an intended name is already taken,
 * `saveImage` / `renameImageToConvention` fall back to a GUID-suffixed
 * alternative instead of overwriting or colliding.
 */

const IMAGE_PREFIX = "images";

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
  return `${IMAGE_PREFIX}/${accountId}/${name}`;
}

/** Strip the account namespace from a stored key (for comparisons). */
function bareName(storedKey: string, accountId: string): string {
  const prefix = `${IMAGE_PREFIX}/${accountId}/`;
  return storedKey.startsWith(prefix)
    ? storedKey.slice(prefix.length)
    : storedKey;
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
  // Prefer the extension that matches the *stored* mime — saveImage may have
  // converted the format (e.g. PNG → JPEG), and the stored ext should be
  // honest about the bytes. Falls back to the original name's extension.
  const ext = extForMime(mime) || extname(originalName).toLowerCase();
  const filePart = sanitizeFilenamePart(
    originalName.slice(0, originalName.length - extname(originalName).length),
  );
  const reportPart = sanitizeFilenamePart(report);
  const datePart = sanitizeFilenamePart(date);
  const name = `${datePart}_${reportPart}_${filePart}${ext}`;
  return name || "";
}

/**
 * Read an uploaded image file from a form's `file` field, or null when
 * absent/empty. The mime falls back to the filename extension then to PNG —
 * the same resolution saveImage applies — so files whose type the browser
 * leaves empty (e.g. HEIC) are labeled honestly before normalization.
 */
export async function readUploadedFile(form: FormData): Promise<{
  buffer: Buffer;
  mime: string;
  originalName: string;
} | null> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return null;
  return {
    buffer: Buffer.from(await file.arrayBuffer()),
    mime: file.type || mimeForFile(file.name) || "image/png",
    originalName: file.name || "pasted.png",
  };
}

/**
 * Persist an uploaded image buffer under a temporary (id-based) key in the
 * account's namespace. Returns the storage key written and the mime type.
 *
 * `(accountId, key)` is the primary key, so the database itself rejects a
 * duplicate name. A free name is picked first, and a fresh GUID is retried if
 * a concurrent write wins the check-then-write race.
 */
export async function saveImage(
  accountId: string,
  buffer: Buffer,
  mime: string,
  originalName: string,
): Promise<{ filename: string; mime: string }> {
  const resolvedMime = mime || mimeForFile(originalName) || "image/png";

  // Normalize before persisting: downscale past 1024px, flatten, re-encode
  // as JPEG (q85). Undecodable/unchanged inputs pass through as-is.
  const normalized = await normalizeStoredImage(buffer);
  const storedBuffer = normalized?.buffer ?? buffer;
  const storedMime = normalized?.mime ?? resolvedMime;
  const ext =
    (normalized ? extForMime(storedMime) : null) ||
    extname(originalName).toLowerCase() ||
    extForMime(resolvedMime) ||
    ".png";

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
          mime: storedMime,
          data: new Uint8Array(storedBuffer),
        },
      });
      return { filename: namespacedKey(accountId, name), mime: storedMime };
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
  await prisma.imageBlob
    .deleteMany({ where: { accountId, key: filename } })
    .catch(() => {});
}
