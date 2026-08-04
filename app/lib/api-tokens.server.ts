import { createHash, randomBytes } from "node:crypto";

/**
 * Machine tokens for the MCP/API endpoint (`/mcp`). The raw token is shown
 * to the user exactly once at creation; only its SHA-256 hash is persisted
 * (api_tokens.tokenHash), so a leaked database never reveals usable tokens.
 * Tokens look like `exp_<43 base64url chars>` and are scoped to one account.
 */

/** A newly generated raw token, e.g. `exp_AbC…`. Never stored. */
export function generateApiToken(): string {
  return `exp_${randomBytes(32).toString("base64url")}`;
}

/** The stored form of a token — SHA-256 hex, so lookups are a single index. */
export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** True when a bearer value looks like one of our tokens (cheap reject). */
export function isApiToken(value: string): boolean {
  return /^exp_[A-Za-z0-9_-]{32,}$/.test(value);
}
