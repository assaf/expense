import "dotenv/config";
import "node:process";

const env = process.env;

/** Postgres connection string. Required — the app fails fast without it. */
export const DATABASE_URL = env.DATABASE_URL ?? "";

/** Vercel Blob read-write token. When set, receipt images go to Blob. */
export const BLOB_READ_WRITE_TOKEN = env.BLOB_READ_WRITE_TOKEN ?? "";

/** S3-compatible storage (MinIO locally, R2/S3 elsewhere). */
export const S3_ENDPOINT = env.S3_ENDPOINT ?? "";
export const S3_REGION = env.S3_REGION ?? "us-east-1";
export const S3_BUCKET = env.S3_BUCKET ?? "";
// MinIO's default credentials; override for anything else.
export const S3_ACCESS_KEY_ID = env.S3_ACCESS_KEY_ID ?? "minioadmin";
export const S3_SECRET_ACCESS_KEY = env.S3_SECRET_ACCESS_KEY ?? "minioadmin";

/**
 * Force the image backend: "blob" | "s3" | "pg". Defaults to Vercel Blob when
 * BLOB_READ_WRITE_TOKEN is set, else S3 when S3_ENDPOINT+S3_BUCKET are set.
 * "pg" stores image bytes in Postgres (BYTEA) — used by dev/tests so no
 * separate service is needed.
 */
export const IMAGE_BACKEND = env.IMAGE_BACKEND ?? "";

export const isProd = env.NODE_ENV === "production";

/** True when Postgres storage is configured (required — the app fails fast without it). */
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
