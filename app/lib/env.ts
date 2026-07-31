import "node:process";
import { join } from "node:path";

const env = process.env;

/** Absolute or relative directory holding CSV state and image files (local mode). */
export const DATA_DIR = env.DATA_DIR ?? "data";

/** Postgres connection string. When set, the app uses Postgres instead of CSVs. */
export const DATABASE_URL = env.DATABASE_URL ?? "";

/** Vercel Blob read-write token. When set, receipt images go to Blob instead of disk. */
export const BLOB_READ_WRITE_TOKEN = env.BLOB_READ_WRITE_TOKEN ?? "";

/** S3-compatible storage (MinIO locally, R2/S3 elsewhere). */
export const S3_ENDPOINT = env.S3_ENDPOINT ?? "";
export const S3_REGION = env.S3_REGION ?? "us-east-1";
export const S3_BUCKET = env.S3_BUCKET ?? "";
// MinIO's default credentials; override for anything else.
export const S3_ACCESS_KEY_ID = env.S3_ACCESS_KEY_ID ?? "minioadmin";
export const S3_SECRET_ACCESS_KEY = env.S3_SECRET_ACCESS_KEY ?? "minioadmin";

export const isProd = env.NODE_ENV === "production";

/** True when Postgres storage is configured (Vercel/Coolify production). */
export function hasDatabase(): boolean {
  return Boolean(DATABASE_URL);
}

/** True when Vercel Blob storage is configured. */
export function hasBlob(): boolean {
  return Boolean(BLOB_READ_WRITE_TOKEN);
}

/** True when S3-compatible storage (e.g. local MinIO) is configured. */
export function hasS3(): boolean {
  return Boolean(S3_ENDPOINT && S3_BUCKET);
}

/** Local images directory (used only in local mode, when Blob is not configured). */
export const IMAGES_DIR = join(DATA_DIR, "images");
