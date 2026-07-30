import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { ulid } from "ulid";
import { imagesDir } from "~/lib/store.server";
import { sanitizeFilenamePart } from "~/lib/validation";

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

/**
 * Build the convention filename:
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
 * Persist an uploaded image buffer under a temporary (id-based) filename.
 * Returns the filename written to disk.
 */
export async function saveImage(
  buffer: Buffer,
  mime: string,
  originalName: string,
): Promise<{ filename: string; mime: string }> {
  const resolvedMime = mime || mimeForFile(originalName) || "image/png";
  const ext =
    extname(originalName).toLowerCase() || extForMime(resolvedMime) || ".png";
  const filename = `${ulid()}${ext}`;
  await writeFile(`${imagesDir()}/${filename}`, buffer);
  return { filename, mime: resolvedMime };
}

/**
 * Rename an image on disk to its convention name (if the expense now has a
 * date + report + original name). Returns the (possibly unchanged) filename.
 */
export async function renameImageToConvention(
  currentFile: string,
  date: string,
  report: string,
  originalName: string,
  mime: string,
): Promise<string> {
  const target = conventionImageName(date, report, originalName, mime);
  if (!target || target === currentFile) return currentFile;
  const from = `${imagesDir()}/${currentFile}`;
  const to = `${imagesDir()}/${target}`;
  if (existsSync(from)) {
    // Avoid clobbering an existing same-named file from a different expense.
    let final = to;
    if (existsSync(to) && from !== to) {
      const ext = extname(target);
      const stem = target.slice(0, target.length - ext.length);
      final = `${imagesDir()}/${stem}-${ulid().slice(-6)}${ext}`;
    }
    await rename(from, final);
    return final.slice(imagesDir().length + 1);
  }
  return currentFile;
}

export async function readImage(
  filename: string,
): Promise<{ buffer: Buffer; mime: string } | null> {
  const full = `${imagesDir()}/${filename}`;
  if (!existsSync(full)) return null;
  const buffer = await readFile(full);
  const mime = mimeForFile(filename);
  return { buffer, mime };
}

export async function deleteImage(filename: string): Promise<void> {
  if (!filename) return;
  const full = `${imagesDir()}/${filename}`;
  if (existsSync(full)) await unlink(full).catch(() => {});
}
