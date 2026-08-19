/**
 * JMAP session lookup for user-supplied API tokens (connected email
 * accounts — Settings → Email accounts). FastMail today; the session
 * handshake is the same for any JMAP provider, only the endpoint differs.
 *
 * Distinct from fastmail.server.ts, which is the app's OWN FastMail mailbox
 * (one global token, module-level session cache). Here every call is scoped
 * to one user's token, so nothing is cached across tokens.
 */

const FASTMAIL_SESSION_URL = "https://api.fastmail.com/jmap/session";
const REQUEST_TIMEOUT_MS = 30_000;

/** What "verify this token" resolved to. */
export interface JmapTokenInfo {
  /** The FastMail account's own address (session `username`). */
  username: string;
  /** JMAP account id for the mail capability (drives all later calls). */
  mailAccountId: string;
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
}

export type JmapTokenVerification =
  | { ok: true; info: JmapTokenInfo }
  | {
      ok: false;
      reason: "invalid-token" | "no-mail-account" | "network";
      message: string;
    };

interface SessionResponse {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  username: string;
  primaryAccounts: Record<string, string>;
}

/**
 * Verify a user-supplied FastMail API token by loading its JMAP session.
 * `invalid-token` covers 401/403 (bad or revoked token); anything else
 * (timeout, 5xx) is `network` so the UI can suggest retrying.
 */
export async function verifyJmapToken(
  token: string,
): Promise<JmapTokenVerification> {
  let res: Response;
  try {
    res = await fetch(FASTMAIL_SESSION_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "network",
      message: `Could not reach FastMail: ${String(err)}`,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      reason: "invalid-token",
      message: "FastMail rejected this token — check it and try again.",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: "network",
      message: `FastMail returned ${res.status} — try again in a moment.`,
    };
  }
  let j: SessionResponse;
  try {
    j = (await res.json()) as SessionResponse;
  } catch {
    return {
      ok: false,
      reason: "network",
      message: "FastMail returned an unreadable session response.",
    };
  }
  const mailAccountId = j.primaryAccounts["urn:ietf:params:jmap:mail"];
  if (!mailAccountId) {
    return {
      ok: false,
      reason: "no-mail-account",
      message:
        "This token has no mail access — recreate it and enable the mail scopes.",
    };
  }
  return {
    ok: true,
    info: {
      username: j.username.toLowerCase(),
      mailAccountId,
      apiUrl: j.apiUrl,
      uploadUrl: j.uploadUrl,
      downloadUrl: j.downloadUrl,
    },
  };
}
