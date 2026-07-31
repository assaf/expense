import "dotenv/config";
import "node:process";

const env = process.env;

/** Postgres connection string. Required — the app fails fast without it. */
export const DATABASE_URL = env.DATABASE_URL ?? "";

/** Vercel Blob read-write token. When set, receipt images go to Blob. */
const BLOB_READ_WRITE_TOKEN = env.BLOB_READ_WRITE_TOKEN ?? "";

/**
 * Force the image backend: "blob" | "pg". Defaults to Vercel Blob when
 * BLOB_READ_WRITE_TOKEN is set. "pg" stores image bytes in Postgres (BYTEA) —
 * used by dev/tests so no separate service is needed.
 */
export const IMAGE_BACKEND = env.IMAGE_BACKEND ?? "";

/**
 * Bootstrap credentials for the very first account + user (created when the
 * database is empty). Subsequent users are created via the signup/join UI.
 */
export const APP_USERNAME = env.APP_USERNAME ?? "";

/** Bootstrap password (see APP_USERNAME). */
export const APP_PASSWORD = env.APP_PASSWORD ?? "";

/** Secret used to sign the session cookie. Required — the app fails fast without it. */
export const SESSION_SECRET = env.SESSION_SECRET ?? "";

/** True when Postgres storage is configured (required — the app fails fast without it). */
export function hasDatabase(): boolean {
  return Boolean(DATABASE_URL);
}

/** True when Vercel Blob storage is configured. */
export function hasBlob(): boolean {
  return Boolean(BLOB_READ_WRITE_TOKEN);
}
