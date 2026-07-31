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
import postgres from "postgres";
import type { Sql } from "postgres";
import { ulid } from "ulid";
import {
  DATABASE_URL,
  IMAGE_BACKEND,
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
 *  2. S3-compatible storage (R2/S3/MinIO) when S3_ENDPOINT + S3_BUCKET are set.
 *  3. Postgres BYTEA when IMAGE_BACKEND=pg (dev/tests — no separate service).
 *
 * IMAGE_BACKEND can force any of the three; otherwise Blob token → S3 config →
 * error. A backend is required: save/read/rename/delete throw a clear error
 * instead of silently falling back to disk.
 *
 * The returned `filename` is the storage key: an `images/...` pathname on
 * every backend, so keys are interchangeable between Blob, S3, and Postgres.
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

type Backend = "blob" | "s3" | "pg";

function backend(): Backend {
  if (IMAGE_BACKEND) {
    if (
      IMAGE_BACKEND === "blob" ||
      IMAGE_BACKEND === "s3" ||
      IMAGE_BACKEND === "pg"
    ) {
      return IMAGE_BACKEND;
    }
    throw new Error(
      `Unknown IMAGE_BACKEND "${IMAGE_BACKEND}" — expected "blob", "s3", or "pg".`,
    );
  }
  if (hasBlob()) return "blob";
  if (hasS3()) return "s3";
  throw new Error(
    "No image storage configured — set BLOB_READ_WRITE_TOKEN, S3_ENDPOINT + S3_BUCKET, or IMAGE_BACKEND=pg.",
  );
}

// --- Postgres BYTEA client (lazy — only used with IMAGE_BACKEND=pg) ---------

let pgSql: Sql | undefined;

function pgDb(): Sql {
  if (!pgSql) {
    if (!DATABASE_URL) throw new Error("DATABASE_URL is not configured");
    pgSql = postgres(DATABASE_URL, {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return pgSql;
}

async function pgExists(key: string): Promise<boolean> {
  const rows =
    await pgDb()`SELECT 1 FROM image_blobs WHERE "key" = ${key} LIMIT 1`;
  return rows.length > 0;
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

  if (backend() === "blob") {
    const blob = await put(toPathname(key), buffer, {
      access: "public",
      contentType: resolvedMime,
      addRandomSuffix: false,
    });
    return { filename: blob.pathname, mime: resolvedMime };
  }

  if (backend() === "s3") {
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

  const pathname = toPathname(key);
  await pgDb()`INSERT INTO image_blobs ("key", "mime", "data") VALUES (${pathname}, ${resolvedMime}, ${buffer})`;
  return { filename: pathname, mime: resolvedMime };
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

  if (backend() === "blob") {
    const from = toPathname(currentFile);
    if (!(await blobExists(from))) return currentFile;
    let to = toPathname(target);
    if (await blobExists(to)) {
      to = suffixedKey(target);
    }
    await blobRename(from, to, { access: "public" });
    return to;
  }

  if (backend() === "s3") {
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

  const from = toPathname(currentFile);
  if (!(await pgExists(from))) return currentFile;
  let to = toPathname(target);
  if (await pgExists(to)) {
    to = suffixedKey(target);
  }
  await pgDb()`UPDATE image_blobs SET "key" = ${to} WHERE "key" = ${from}`;
  return to;
}

export async function readImage(
  filename: string,
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (!filename) return null;

  if (backend() === "blob") {
    const result = await get(toPathname(filename), { access: "public" });
    if (!result) return null;
    const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
    return { buffer, mime: result.blob.contentType ?? mimeForFile(filename) };
  }

  if (backend() === "s3") {
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

  const rows =
    await pgDb()`SELECT "data", "mime" FROM image_blobs WHERE "key" = ${toPathname(filename)}`;
  if (rows.length === 0) return null;
  const row = rows[0] as { data: Buffer; mime: string };
  return { buffer: row.data, mime: row.mime || mimeForFile(filename) };
}

export async function deleteImage(filename: string): Promise<void> {
  if (!filename) return;
  if (backend() === "blob") {
    await del(toPathname(filename)).catch(() => {});
    return;
  }
  if (backend() === "s3") {
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
  await pgDb()`DELETE FROM image_blobs WHERE "key" = ${toPathname(filename)}`.catch(
    () => {},
  );
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
