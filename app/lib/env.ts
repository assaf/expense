import "dotenv/config";
import "node:process";

const env = process.env;

/** Postgres connection string. Required — the app fails fast without it. */
export const DATABASE_URL = env.DATABASE_URL ?? "";

/**
 * Bootstrap credentials for the very first account + user (created when the
 * database is empty). Subsequent users are created via the signup/join UI.
 */
export const APP_USERNAME = env.APP_USERNAME ?? "";

/** Bootstrap password (see APP_USERNAME). */
export const APP_PASSWORD = env.APP_PASSWORD ?? "";

/** Secret used to sign the session cookie. Required — the app fails fast without it. */
export const SESSION_SECRET = env.SESSION_SECRET ?? "";

/** Resend API key — fetches received email content/attachments and sends failure replies. */
export const RESEND_API_KEY = env.RESEND_API_KEY ?? "";

/** Resend inbound webhook signing secret (`whsec_…`) — verifies `email.received` webhooks. */
export const INBOUND_EMAIL_WEBHOOK_SECRET =
  env.INBOUND_EMAIL_WEBHOOK_SECRET ?? "";

/** The address users forward receipts to — shown in Settings (e.g. receipts@labnotes.org). */
export const INBOUND_EMAIL_ADDRESS = env.INBOUND_EMAIL_ADDRESS ?? "";

/** DeepSeek API key — parses receipt text and (when supported) OCRs images. */
export const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY ?? "";

/** DeepSeek model id (default: deepseek-v4-flash). */
export const DEEPSEEK_MODEL = env.DEEPSEEK_MODEL || "deepseek-v4-flash";

/**
 * OCR backend for image/scanned receipts:
 *  - "auto"     try DeepSeek vision first, fall back to local tesseract OCR
 *  - "deepseek" DeepSeek vision only (errors are reported back)
 *  - "tesseract"local OCR only
 */
export const RECEIPT_OCR_MODE = (env.RECEIPT_OCR_MODE || "auto") as
  | "auto"
  | "deepseek"
  | "tesseract";

/** True when Postgres storage is configured (required — the app fails fast without it). */
export function hasDatabase(): boolean {
  return Boolean(DATABASE_URL);
}

/**
 * Secret gating GET /api/smoke (post-deploy PDF+OCR health check). Requests
 * must send it in the `x-smoke-secret` header; when unset the route is
 * disabled (404). `scripts/deploy` uses it after every production deploy.
 */
export const SMOKE_TEST_SECRET = env.SMOKE_TEST_SECRET ?? "";
