import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { ulid } from "ulid";
import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { isUniqueViolation } from "~/lib/db/pg-errors";
import { normalizeStoredImage, resizeToJpeg } from "~/lib/image-normalize";
import { sanitizeFilenamePart } from "~/lib/validation";

/**
 * Receipt image storage, Postgres BYTEA only (`image_blobs` table). No
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
  ".pdf": "application/pdf",
};

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/heic": ".heic",
};

/** Mime types the store accepts. Anything else (a browser-supplied
 * `text/html` or `image/svg+xml` from a crafted upload, an arbitrary MCP
 * `mime` arg, an odd Resend attachment type) is coerced to
 * `application/octet-stream` at save time so the image route never serves
 * renderable content (HTML/SVG with scripts) at a same-origin URL.
 * PDFs are allowed: uploads are rasterized before storage, and a raw PDF
 * is inert in a browser. */
const STORABLE_MIMES = new Set([
  ...Object.keys(EXT_BY_MIME),
  "application/pdf",
]);

/** Coerce a mime to the storable set (see STORABLE_MIMES). */
function storableMime(mime: string): string {
  return STORABLE_MIMES.has(mime) ? mime : "application/octet-stream";
}

/** Mime for a filename's extension, or `fallback` when unknown. The single
 * mime-by-extension map for the app; the MCP capture path guesses the same
 * way (images.server is the source of truth). */
export function mimeForFile(filename: string, fallback = ""): string {
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

/** Strip the account namespace from a stored key (`images/{accountId}/…` →
 * bare name). Shared by the internal key comparisons and the ZIP export,
 * which keeps plain filenames in the archive. */
export function bareName(storedKey: string, accountId: string): string {
  const prefix = `${IMAGE_PREFIX}/${accountId}/`;
  return storedKey.startsWith(prefix)
    ? storedKey.slice(prefix.length)
    : storedKey;
}

async function pgExists(accountId: string, key: string): Promise<boolean> {
  const row = await db.orm.public.ImageBlob.where((b) =>
    and(b.accountId.eq(accountId), b.key.eq(key)),
  )
    .select("key")
    .first();
  return row !== null;
}

/** How many GUID-suffixed candidates to try before using a full GUID. */
const MAX_NAME_ATTEMPTS = 6;

/**
 * Return a name for the account namespace that is not already taken,
 * preferring `baseName` but switching to GUID-suffixed alternatives when it
 * collides with an existing image. The exact name is unimportant; only that
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
 * Returns "" when date, report, or original name is missing; callers keep
 * the temporary name then and rename later once the expense is complete.
 */
function conventionImageName(
  date: string,
  report: string,
  originalName: string,
  mime: string,
): string {
  if (!date || !report || !originalName) return "";
  // Prefer the extension that matches the *stored* mime: saveImage may have
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

/** Response headers for serving stored image bytes: nosniff + a sandboxing
 * CSP, so even if a stored blob's mime were ever renderable (HTML/SVG), a
 * direct navigation could not execute it in document mode on this origin.
 * Shared by /expense/:id/image and the /api/expense draft preview. */
export function imageResponseHeaders(
  mime: string,
  cacheControl: string,
): Record<string, string> {
  return {
    "Content-Type": mime,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
}

/**
 * Read an uploaded image file from a form's `file` field, or null when
 * absent/empty. The mime falls back to the filename extension then to PNG,
 * the same resolution saveImage applies, so files whose type the browser
 * leaves empty (e.g. HEIC) are labeled honestly before normalization.
 */
export async function readUploadedFile(
  form: FormData,
): Promise<UploadedFileResult> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "missing" };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "too-large" };
  }
  return {
    ok: true,
    buffer: Buffer.from(await file.arrayBuffer()),
    mime: file.type || mimeForFile(file.name) || "image/png",
    originalName: file.name || "pasted.png",
  };
}

/**
 * Largest receipt file the upload path accepts (bytes). Matches the MCP
 * capture cap: bigger than any real receipt (a phone photo or a scanned
 * PDF) while bounding the request body `request.formData()` must buffer
 * and sharp must decode. The platform body limit is a backstop, not the
 * check.
 */
export const MAX_UPLOAD_BYTES = 15_000_000;

export type UploadedFileResult =
  | { ok: true; buffer: Buffer; mime: string; originalName: string }
  | { ok: false; error: "missing" | "too-large" };

/** User-facing error message for a rejected upload, shared by the draft,
 * image-replace, and MCP capture paths so they can't drift apart. */
export function uploadErrorMessage(error: "missing" | "too-large"): string {
  return error === "too-large"
    ? "Image too large — receipts must be under 15MB."
    : "No image received.";
}

/** The stored name for a rasterized PDF upload: `receipt.pdf` → `receipt.png`. */
export function pdfImageName(originalName: string): string {
  const stem = originalName.replace(/\.pdf$/i, "").trim();
  return `${stem || "receipt"}.png`;
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
  // The mime is coerced to the storable set, so a crafted upload (HTML/SVG
  // bytes with a browser-supplied content type) can never be stored with a
  // renderable type and later served as a same-origin document.
  const storedMime = storableMime(normalized?.mime ?? resolvedMime);
  const ext =
    (normalized ? extForMime(storedMime) : null) ||
    extname(originalName).toLowerCase() ||
    extForMime(resolvedMime) ||
    ".png";

  // Precompute the 160px thumbnail at save time; the list page hammers
  // this and on-the-fly sharp resizing was the biggest CPU consumer.
  const thumbnail = await resizeToJpeg(storedBuffer, {
    maxWidth: 160,
    maxHeight: 160,
    quality: 80,
  }).catch(() => null as Buffer | null);

  const base = `${ulid()}${ext}`;
  let name = await uniqueName(accountId, base, (key) =>
    pgExists(accountId, key),
  );
  for (let attempt = 0; ; attempt++) {
    try {
      await db.orm.public.ImageBlob.create({
        accountId,
        key: namespacedKey(accountId, name),
        mime: storedMime,
        data: new Uint8Array(storedBuffer),
        ...(thumbnail ? { thumbnail: new Uint8Array(thumbnail) } : {}),
      });
      return { filename: namespacedKey(accountId, name), mime: storedMime };
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= MAX_NAME_ATTEMPTS) {
        throw error;
      }
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
  await db.orm.public.ImageBlob.where((b) =>
    and(b.accountId.eq(accountId), b.key.eq(currentFile)),
  ).updateAll({ key: to });
  return to;
}

export async function readImage(
  accountId: string,
  filename: string,
): Promise<{ buffer: Buffer; mime: string; thumbnail: Buffer | null } | null> {
  if (!filename) return null;

  const row = await db.orm.public.ImageBlob.where((b) =>
    and(b.accountId.eq(accountId), b.key.eq(filename)),
  )
    .select("data", "mime", "thumbnail")
    .first();
  if (!row) return null;
  return {
    buffer: Buffer.from(row.data),
    mime: row.mime || mimeForFile(filename),
    thumbnail: row.thumbnail ? Buffer.from(row.thumbnail) : null,
  };
}

export async function deleteImage(
  accountId: string,
  filename: string,
): Promise<void> {
  if (!filename) return;
  try {
    await db.orm.public.ImageBlob.where((b) =>
      and(b.accountId.eq(accountId), b.key.eq(filename)),
    ).deleteAll();
  } catch {
    // best-effort: the row may already be gone
  }
}
