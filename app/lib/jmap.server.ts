/**
 * JMAP client for user-supplied API tokens (connected email accounts —
 * Settings → Email accounts). FastMail today; the session handshake is the
 * same for any JMAP provider, only the endpoint differs.
 *
 * Distinct from fastmail.server.ts, which is the app's OWN FastMail mailbox
 * (one global token, module-level session cache). Here every call is scoped
 * to one user's token; sessions are cached per token (a cache entry is
 * evicted when its lookup fails, so revoked tokens don't stick).
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

async function loadSession(token: string): Promise<JmapTokenVerification> {
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

/**
 * Verify a user-supplied FastMail API token by loading its JMAP session.
 * `invalid-token` covers 401/403 (bad or revoked token); anything else
 * (timeout, 5xx) is `network` so the UI can suggest retrying.
 */
export async function verifyJmapToken(
  token: string,
): Promise<JmapTokenVerification> {
  return loadSession(token);
}

// --- Per-token JMAP calls ----------------------------------------------------

const sessionCache = new Map<string, Promise<JmapTokenInfo>>();

/** The JMAP session for a user token, cached per token (per serverless
 * instance). A failed lookup is evicted so the next call retries. */
export async function jmapSessionForToken(
  token: string,
): Promise<JmapTokenInfo> {
  let cached = sessionCache.get(token);
  if (!cached) {
    cached = loadSession(token).then((r) => {
      if (r.ok) return r.info;
      throw new Error(r.message);
    });
    sessionCache.set(token, cached);
    cached.catch(() => sessionCache.delete(token));
  }
  return cached;
}

interface ApiResponse {
  methodResponses: [string, unknown, string][];
}

/** Extra JMAP capabilities beyond core + mail (e.g. submission for sending). */
export type JmapCapability = "urn:ietf:params:jmap:submission";

/**
 * POST a batch of JMAP method calls with a user token; throws on the first
 * per-call error — including per-object /set failures surfaced via
 * notUpdated/notCreated/notDestroyed (the FastMail gotcha the app's own
 * client, fastmail.server.ts, documents).
 */
export async function jmapCall(
  token: string,
  methodCalls: unknown[][],
  capabilities: JmapCapability[] = [],
): Promise<[string, unknown, string][]> {
  const s = await jmapSessionForToken(token);
  const res = await fetch(s.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        ...capabilities,
      ],
      methodCalls,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`JMAP API failed: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as ApiResponse;
  for (const [name, args] of j.methodResponses) {
    if (name === "error") {
      throw new Error(`JMAP ${name} error: ${JSON.stringify(args)}`);
    }
    const a = args as {
      notUpdated?: Record<string, unknown>;
      notCreated?: Record<string, unknown>;
      notDestroyed?: Record<string, unknown>;
    };
    for (const key of ["notUpdated", "notCreated", "notDestroyed"] as const) {
      const failures = a[key];
      if (failures && Object.keys(failures).length > 0) {
        throw new Error(`JMAP ${name} ${key}: ${JSON.stringify(failures)}`);
      }
    }
  }
  return j.methodResponses;
}
