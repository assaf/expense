import { existsSync } from "node:fs";
import "node:process";

// Load the local .env in dev/test (existing vars win, dotenv-style).
// Vercel injects env vars directly and ships no .env file — skip when
// absent, since loadEnvFile throws if the file is missing.
if (existsSync(".env")) process.loadEnvFile(".env");

const env = process.env;

/** Postgres connection string. Required — the app fails fast without it. */
export const DATABASE_URL = env.DATABASE_URL ?? "";

/**
 * Bootstrap credentials for the very first account + user (created when the
 * database is empty). Subsequent users are created via the signup/join UI.
 */
export const APP_EMAIL = env.APP_EMAIL ?? "";

/** Bootstrap password (see APP_EMAIL). */
export const APP_PASSWORD = env.APP_PASSWORD ?? "";

/** Secret used to sign the session cookie. Required — the app fails fast without it. */
export const SESSION_SECRET = env.SESSION_SECRET ?? "";

/** Resend API key — fetches received email content/attachments and sends failure replies. */
export const RESEND_API_KEY = env.RESEND_API_KEY ?? "";

/** Resend inbound webhook signing secret (`whsec_…`) — verifies `email.received` webhooks. */
export const INBOUND_EMAIL_WEBHOOK_SECRET =
  env.INBOUND_EMAIL_WEBHOOK_SECRET ?? "";

/** The address users forward receipts to — shown in Settings (e.g. receipts@expense.labnotes.org). */
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

/**
 * Public base URL the OAuth metadata advertises (issuer + endpoints) instead
 * of deriving it from each request. Set it when the app sits behind a
 * TLS-terminating proxy (e.g. a local https://expense.localhost setup) so
 * clients see the public origin, not the proxy-internal one. Optional.
 */
export const PUBLIC_URL = env.PUBLIC_URL ?? "";
