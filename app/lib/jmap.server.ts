import { readBodyLimited } from "~/lib/ssrf.server";

/**
 * JMAP client for user-supplied API tokens (connected email accounts,
 * Email page → Email accounts). FastMail today; the session handshake is the
 * same for any JMAP provider, only the endpoint differs.
 *
 * Distinct from fastmail.server.ts, which is the app's OWN FastMail mailbox
 * (one global token, module-level session cache). Here every call is scoped
 * to one user's token; sessions are cached per token (a cache entry is
 * evicted when its lookup fails, so revoked tokens don't stick).
 */

const FASTMAIL_SESSION_URL = "https://api.fastmail.com/jmap/session";

/** Shared JMAP request timeout. Both JMAP clients (fastmail.server.ts, the
 * app's own mailbox, and this module's per-token client) abort hung
 * requests with it. The batch-POST/error-walk core (`jmapBatch`,
 * `jmapUploadBlob`) is also shared; the session loading and error
 * classification stay per-client (their error contracts differ on
 * purpose). */

export const REQUEST_TIMEOUT_MS = 30_000;
/** Hard cap on a downloaded RFC 5322 email blob (both transports). Bounds
 * the memory PostalMime needs to parse the message and every attachment it
 * decodes. The upload path caps receipts at 15MB; the email path must not
 * be looser. Oversized mail is skipped by the drain (left in place). */
export const MAX_EMAIL_BYTES = 15_000_000;

/** Format a JMAP address participant as "Name <email>" (bare email when
 * there is no name; null when there is no address at all). Shared by both
 * raw-email readers. */
export function formatAddress(
  a?: { name?: string; email?: string } | null,
): string | null {
  if (!a?.email) return null;
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

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
 * POST a batch of JMAP method calls; throws on the first per-call error,
 * including per-object /set failures surfaced via notUpdated/notCreated/
 * notDestroyed (the FastMail gotcha). Shared core behind both clients:
 * `jmapCall` (per-token, strict) and fastmail.server.ts's app-mailbox
 * client (which passes `tolerateNotFoundDestroy` for idempotent deletes).
 */
export async function jmapBatch(
  apiUrl: string,
  authorization: string,
  methodCalls: unknown[][],
  capabilities: JmapCapability[] = [],
  opts: { tolerateNotFoundDestroy?: boolean } = {},
): Promise<[string, unknown, string][]> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authorization,
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
        // Destroying an already-removed object reports notFound in
        // notDestroyed (a concurrent drain deleted it first). For an
        // idempotent delete that is the desired end state, not a failure,
        // so skip it; any other notDestroyed reason still throws.
        if (key === "notDestroyed" && opts.tolerateNotFoundDestroy) {
          const hardFailures = Object.values(failures).filter(
            (f) => (f as { type?: string }).type !== "notFound",
          );
          if (hardFailures.length === 0) continue;
        }
        throw new Error(`JMAP ${name} ${key}: ${JSON.stringify(failures)}`);
      }
    }
  }
  return j.methodResponses;
}

/** Upload a raw RFC 5322 message blob; returns the blobId. Shared by both
 * send flows (fastmail.server.ts's EmailSubmission path and the connected
 * account's Inbox-write path). */
export async function jmapUploadBlob(
  uploadUrl: string,
  mailAccountId: string,
  authorization: string,
  raw: Buffer,
): Promise<string> {
  const url = uploadUrl.replace("{accountId}", mailAccountId);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "message/rfc822",
    },
    body: new Uint8Array(raw),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as { blobId?: string };
  if (!j.blobId) throw new Error("upload missing blobId");
  return j.blobId;
}

/**
 * POST a batch of JMAP method calls with a user token; throws on the first
 * per-call error, including per-object /set failures surfaced via
 * notUpdated/notCreated/notDestroyed (the FastMail gotcha the app's own
 * client, fastmail.server.ts, documents).
 */
export async function jmapCall(
  token: string,
  methodCalls: unknown[][],
  capabilities: JmapCapability[] = [],
  opts: { tolerateNotFoundDestroy?: boolean } = {},
): Promise<[string, unknown, string][]> {
  const s = await jmapSessionForToken(token);
  return jmapBatch(
    s.apiUrl,
    `Bearer ${token}`,
    methodCalls,
    capabilities,
    opts,
  );
}

// --- PushSubscription + Email/import (shared by both auth flavors) ----------

/** A FastMail push subscription (PushSubscription/get). */
export interface PushSubscriptionInfo {
  id: string;
  deviceClientId: string;
  expires: string | null;
  url: string;
}

/** PushSubscription/get response args. */
interface PushListArgs {
  list?: PushSubscriptionInfo[];
}

/** PushSubscription/set create response args. */
interface PushCreateArgs {
  created?: Record<string, { id: string } | null>;
}

/** Email/import response args. */
interface ImportArgs {
  created?: Record<string, { id: string } | null>;
}

/** List the account's push subscriptions (PushSubscription/get). */
export async function jmapPushList(
  token: string,
): Promise<PushSubscriptionInfo[]> {
  const responses = await jmapCall(token, [["PushSubscription/get", {}, "m0"]]);
  // JMAP methodResponses arrive as untyped wire tuples; assert the args
  // shape once per call and read typed fields from the named const.
  const args = responses[0]![1] as PushListArgs;
  return args.list ?? [];
}

/** Create a push subscription (PushSubscription/set); returns the new id.
 * Throws when FastMail rejects the create. */
export async function jmapPushCreate(
  token: string,
  opts: {
    url: string;
    deviceClientId: string;
    p256dh: string;
    auth: string;
    expires: string;
  },
  jmapOpts: { tolerateNotFoundDestroy?: boolean } = {},
): Promise<string> {
  const responses = await jmapCall(
    token,
    [
      [
        "PushSubscription/set",
        {
          create: {
            sub1: {
              deviceClientId: opts.deviceClientId,
              url: opts.url,
              types: ["Email"],
              keys: { p256dh: opts.p256dh, auth: opts.auth },
              expires: opts.expires,
            },
          },
        },
        "m0",
      ],
    ],
    [],
    jmapOpts,
  );
  const args = responses[0]![1] as PushCreateArgs;
  const id = args.created?.["sub1"]?.id;
  if (!id) throw new Error("PushSubscription/set created no subscription");
  return id;
}

/** Echo FastMail's PushVerification code back (completes the handshake). */
export async function jmapPushVerify(
  token: string,
  subscriptionId: string,
  code: string,
  jmapOpts: { tolerateNotFoundDestroy?: boolean } = {},
): Promise<void> {
  await jmapCall(
    token,
    [
      [
        "PushSubscription/set",
        { update: { [subscriptionId]: { verificationCode: code } } },
        "m0",
      ],
    ],
    [],
    jmapOpts,
  );
}

/** Destroy a push subscription (PushSubscription/set destroy). */
export async function jmapPushDestroy(
  token: string,
  subscriptionId: string,
  jmapOpts: { tolerateNotFoundDestroy?: boolean } = {},
): Promise<void> {
  await jmapCall(
    token,
    [["PushSubscription/set", { destroy: [subscriptionId] }, "m0"]],
    [],
    jmapOpts,
  );
}

/** Import a raw message blob into a mailbox (Email/import); returns the new
 * email id. Shared by the receipts pipeline's Sent-box write and the
 * connected accounts' Inbox write. */
export async function jmapImportEmail(
  token: string,
  opts: { blobId: string; mailboxId: string },
): Promise<string> {
  const responses = await jmapCall(token, [
    [
      "Email/import",
      {
        accountId: (await jmapSessionForToken(token)).mailAccountId,
        emails: {
          e1: {
            blobId: opts.blobId,
            mailboxIds: opts.mailboxId ? { [opts.mailboxId]: true } : {},
          },
        },
      },
      "m0",
    ],
  ]);
  const args = responses[0]![1] as ImportArgs;
  const created = args.created?.["e1"];
  if (!created) throw new Error("Email/import did not create the message");
  return created.id;
}

/** The common shape of a downloaded RFC 5322 email: fastmail.server's
 * RawEmail and email-connection-mail's RawConnectionEmail both use it. */
export interface RawRfc822Email {
  id: string;
  raw: Buffer;
  receivedAt: string;
  subject: string;
  from: string | null;
  to: string[];
  messageId: string;
}

/** Download an email's RFC 5322 blob and map its metadata to the common
 * shape. Shared by both transports (the app's mailbox and connected
 * accounts); the caller owns the Email/get lookup and the auth headers.
 * The top-level Email blob is the full RFC 5322 message; FastMail serves it
 * for both message/rfc822 and application/octet-stream. */
export async function fetchRawRfc822(opts: {
  id: string;
  email:
    | {
        blobId?: string;
        receivedAt?: string;
        subject?: string;
        from?: Array<{ name?: string; email?: string }>;
        to?: Array<{ name?: string; email?: string }>;
        messageId?: string;
      }
    | undefined;
  accountId: string;
  downloadUrl: string;
  headers: Record<string, string>;
}): Promise<RawRfc822Email> {
  const email = opts.email;
  if (!email) throw new Error(`Email ${opts.id} not found`);
  const url = opts.downloadUrl
    .replace("{accountId}", opts.accountId)
    .replace("{blobId}", email.blobId ?? "")
    .replace("{name}", "email.eml")
    .replace("{type}", "message/rfc822");
  const res = await fetch(url, {
    headers: opts.headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`email download failed: ${res.status} ${await res.text()}`);
  }
  return {
    id: opts.id,
    raw: await readBodyLimited(res, MAX_EMAIL_BYTES).catch(() => {
      throw new Error(
        `email too large to process (over ${MAX_EMAIL_BYTES} bytes)`,
      );
    }),
    receivedAt: email.receivedAt ?? new Date().toISOString(),
    subject: email.subject ?? "",
    from: formatAddress(email.from?.[0]),
    to: (email.to ?? []).map((a) => formatAddress(a) ?? "").filter(Boolean),
    messageId: email.messageId ?? "",
  };
}
