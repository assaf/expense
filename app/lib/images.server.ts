import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { del, get, put, rename as blobRename } from "@vercel/blob";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ulid } from "ulid";
import {
  IMAGES_DIR,
  hasBlob,
  hasS3,
  S3_ACCESS_KEY_ID,
  S3_BUCKET,
  S3_ENDPOINT,
  S3_REGION,
  S3_SECRET_ACCESS_KEY,
} from "~/lib/env";
import { sanitizeFilenamePart } from "~/lib/validation";

/**
 * Receipt image storage, selected by environment:
 *  1. Vercel Blob under the `images/` prefix when BLOB_READ_WRITE_TOKEN is set
 *     (Vercel production).
 *  2. S3-compatible storage (local MinIO, or R2/S3) when S3_ENDPOINT + S3_BUCKET
 *     are set (local dev/tests, alternate clouds).
 *  3. Local files under DATA_DIR/images otherwise (no-infra fallback).
 *
 * The returned `filename` is the storage key: a bare name in local mode, an
 * `images/...` pathname in blob/S3 mode. Keys are interchangeable between the
 * blob and S3 backends.
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

/** Normalize a stored key to a blob/S3 pathname (bare names get the prefix). */
function toPathname(name: string): string {
  return name.startsWith(`${BLOB_PREFIX}/`) ? name : `${BLOB_PREFIX}/${name}`;
}

// --- S3 client (lazy — only created when the S3 backend is active) ---------

let s3Client: S3Client | undefined;

function s3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: S3_ACCESS_KEY_ID,
        secretAccessKey: S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NotFound" ||
    e.name === "NoSuchKey" ||
    e.$metadata?.httpStatusCode === 404
  );
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
 * Persist an uploaded image buffer under a temporary (id-based) key.
 * Returns the storage key written and the resolved mime type.
 */
export async function saveImage(
  buffer: Buffer,
  mime: string,
  originalName: string,
): Promise<{ filename: string; mime: string }> {
  const resolvedMime = mime || mimeForFile(originalName) || "image/png";
  const ext =
    extname(originalName).toLowerCase() || extForMime(resolvedMime) || ".png";
  const key = `${ulid()}${ext}`;

  if (hasBlob()) {
    const blob = await put(toPathname(key), buffer, {
      access: "public",
      contentType: resolvedMime,
      addRandomSuffix: false,
    });
    return { filename: blob.pathname, mime: resolvedMime };
  }

  if (hasS3()) {
    await s3().send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: toPathname(key),
        Body: buffer,
        ContentType: resolvedMime,
      }),
    );
    return { filename: toPathname(key), mime: resolvedMime };
  }

  await writeFile(`${IMAGES_DIR}/${key}`, buffer);
  return { filename: key, mime: resolvedMime };
}

/**
 * Rename an image to its convention name (if the expense now has a
 * date + report + original name). Returns the (possibly unchanged) key.
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

  if (hasBlob()) {
    const from = toPathname(currentFile);
    if (!(await blobExists(from))) return currentFile;
    let to = toPathname(target);
    if (await blobExists(to)) {
      to = suffixedKey(target);
    }
    await blobRename(from, to, { access: "public" });
    return to;
  }

  if (hasS3()) {
    const from = toPathname(currentFile);
    if (!(await s3Exists(from))) return currentFile;
    let to = toPathname(target);
    if (await s3Exists(to)) {
      to = suffixedKey(target);
    }
    await s3().send(
      new CopyObjectCommand({
        Bucket: S3_BUCKET,
        CopySource: `${S3_BUCKET}/${from}`,
        Key: to,
      }),
    );
    await s3().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: from }));
    return to;
  }

  const from = `${IMAGES_DIR}/${currentFile}`;
  const to = `${IMAGES_DIR}/${target}`;
  if (existsSync(from)) {
    // Avoid clobbering an existing same-named file from a different expense.
    let final = to;
    if (existsSync(to) && from !== to) {
      final = `${IMAGES_DIR}/${suffixedKey(target)}`;
    }
    await rename(from, final);
    return final.slice(IMAGES_DIR.length + 1);
  }
  return currentFile;
}

export async function readImage(
  filename: string,
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (!filename) return null;

  if (hasBlob()) {
    const result = await get(toPathname(filename), { access: "public" });
    if (!result) return null;
    const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
    return { buffer, mime: result.blob.contentType ?? mimeForFile(filename) };
  }

  if (hasS3()) {
    try {
      const result = await s3().send(
        new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: toPathname(filename),
        }),
      );
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) return null;
      return {
        buffer: Buffer.from(bytes),
        mime: result.ContentType ?? mimeForFile(filename),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  const full = `${IMAGES_DIR}/${filename}`;
  if (!existsSync(full)) return null;
  const buffer = await readFile(full);
  const mime = mimeForFile(filename);
  return { buffer, mime };
}

export async function deleteImage(filename: string): Promise<void> {
  if (!filename) return;
  if (hasBlob()) {
    await del(toPathname(filename)).catch(() => {});
    return;
  }
  if (hasS3()) {
    await s3()
      .send(
        new DeleteObjectCommand({
          Bucket: S3_BUCKET,
          Key: toPathname(filename),
        }),
      )
      .catch(() => {});
    return;
  }
  const full = `${IMAGES_DIR}/${filename}`;
  if (existsSync(full)) await unlink(full).catch(() => {});
}

/** Collision-safe convention key: `<stem>-<6 chars><ext>` (all backends). */
function suffixedKey(target: string): string {
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  return `${BLOB_PREFIX}/${stem}-${ulid().slice(-6)}${ext}`;
}

async function blobExists(pathname: string): Promise<boolean> {
  const blob = await get(pathname, { access: "public" });
  return blob !== null;
}

async function s3Exists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}
