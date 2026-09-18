import { z } from "zod";

import { fetchPublicUrl, readBodyLimited, SsrfError } from "~/lib/ssrf.server";
import { MAX_RECEIPT_BYTES } from "~/lib/upload-limits";

/**
 * Session endpoint override: the test suite points this at a local mock
 * (see launchServer.ts) so connect and onboarding flows stay offline. Read
 * at call time from process.env, not via env.ts — importing env.ts here
 * makes this module re-run env.ts's test network guard on every
 * vi.resetModules() re-import, which clobbers the fetch stubs the
 * token-crypto tests install.
 */
export const FASTMAIL_SESSION_URL =
  process.env.JMAP_SESSION_URL || "https://api.fastmail.com/jmap/session";

/** A JMAP endpoint plus the exact Authorization header to send. The app's
 * own mailbox and every connected account are described by one of these,
 * so nothing below the session lookup is provider-specific. */
export interface JmapServer {
  sessionUrl: string;
  /** The finished header value: `Bearer <token>` or `Basic <base64>`. */
  authorization: string;
}

/** The injectable session fetch. Tests substitute one so a loopback mock
 * stays reachable (the SSRF guard blocks loopback by design). */
export type SessionFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** Normalize a user-supplied JMAP endpoint (RFC 8620 §2.2): a bare host —
 * or a "/" path — becomes the well-known session path, an explicit path is
 * kept verbatim (an operator may paste an exact session URL), and a
 * trailing slash is stripped. Throws on an unparseable URL. */
export function resolveJmapSessionUrl(input: string): string {
  const url = new URL(input);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/.well-known/jmap";
  }
  return url.toString().replace(/\/$/, "");
}

/** True when the URL is the app's own (operator-controlled) endpoint: it
 * may be a loopback mock in tests and needs no SSRF guard. */
function isAppSessionUrl(sessionUrl: string): boolean {
  return sessionUrl === FASTMAIL_SESSION_URL;
}

/** A human label for error messages: "Fastmail" for the app's own
 * endpoint, otherwise the server's host. */
export function serverLabel(sessionUrl: string): string {
  if (isAppSessionUrl(sessionUrl)) return "Fastmail";
  try {
    return new URL(sessionUrl).host;
  } catch {
    return sessionUrl;
  }
}

/** The default session fetch: plain fetch for the app's own endpoint (an
 * operator-controlled, possibly loopback URL), the SSRF-guarded fetch for a
 * user-supplied server. */
const defaultSessionFetch: SessionFetch = (url, init) => {
  if (isAppSessionUrl(url)) return fetch(url, init);
  return fetchPublicUrl(url, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: init.headers as Record<string, string> | undefined,
  });
};

/** Shared JMAP request timeout. Both JMAP clients (fastmail.server.ts, the
 * app's own mailbox, and this module's per-token client) abort hung
 * requests with it. The batch-POST/error-walk core (`jmapBatch`,
 * `jmapUploadBlob`) is also shared; the session loading and error
 * classification stay per-client (their error contracts differ on
 * purpose). */

export const REQUEST_TIMEOUT_MS = 30_000;
/** Hard cap on a downloaded RFC 5322 email blob (both transports). Bounds
 * the memory PostalMime needs to parse the message and every attachment it
 * decodes. The upload path caps receipts at the same size; the email path
 * must not be looser. Oversized mail is skipped by the drain (left in
 * place). */
export const MAX_EMAIL_BYTES = MAX_RECEIPT_BYTES;

/** Format a JMAP address participant as "Name <email>" (bare email when
 * there is no name; null when there is no address at all). Shared by both
 * raw-email readers. */
export function formatAddress(
  a?: { name?: string | null; email?: string | null } | null,
): string | null {
  if (!a?.email) return null;
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

/** What "verify this token" resolved to. */
export interface JmapTokenInfo {
  /** The Fastmail account's own address (session `username`). */
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

/** The RFC 8621 session document, narrowed to what the app uses. Zod
 * validated at the wire boundary: the URLs from here feed .replace()
 * templates and every later fetch, and the session is cached per server
 * for the instance lifetime, so one wrong shape would poison them all
 * (the same failure class as EXPENSE-S). */
const sessionResponseSchema = z.object({
  apiUrl: z.string(),
  uploadUrl: z.string(),
  downloadUrl: z.string(),
  username: z.string(),
  primaryAccounts: z.record(z.string(), z.string()).default({}),
  /** Diagnostic only; not used for routing. */
  capabilities: z.record(z.string(), z.unknown()).default({}),
  accounts: z
    .record(
      z.string(),
      z.object({
        accountCapabilities: z.record(z.string(), z.unknown()).default({}),
        isReadOnly: z.boolean().default(false),
      }),
    )
    .default({}),
});

const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";

/** The mail account id to drive every later call: the primary mail account
 * when the server names one, otherwise the first writable account that
 * advertises the mail capability (RFC 8621 §2.5 makes Mailboxes optional,
 * but a mail account must exist for the pipeline to read anything). */
function selectMailAccountId(
  j: z.infer<typeof sessionResponseSchema>,
): string | undefined {
  const primary = j.primaryAccounts[MAIL_CAPABILITY];
  if (primary) return primary;
  for (const [id, account] of Object.entries(j.accounts)) {
    if (account.isReadOnly) continue;
    if (account.accountCapabilities[MAIL_CAPABILITY] !== undefined) return id;
  }
  return undefined;
}

/** Hard cap on the session document: it is a small JSON object, and a
 * hostile or broken server must not be able to stream into the function. */
const SESSION_MAX_BYTES = 256 * 1024;

async function loadSession(
  server: JmapServer,
  fetchImpl: SessionFetch = defaultSessionFetch,
): Promise<JmapTokenVerification> {
  const label = serverLabel(server.sessionUrl);
  const appEndpoint = label === "Fastmail";
  let res: Response;
  try {
    res = await fetchImpl(server.sessionUrl, {
      headers: { Authorization: server.authorization },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // The SSRF guard's messages are already user-facing and specific.
    if (err instanceof SsrfError) {
      return { ok: false, reason: "network", message: err.message };
    }
    return {
      ok: false,
      reason: "network",
      message: `Could not reach ${label}: ${String(err)}`,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      reason: "invalid-token",
      message: appEndpoint
        ? "Fastmail rejected this token — check it and try again."
        : "The server rejected that credential.",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: "network",
      message: appEndpoint
        ? `Fastmail returned ${res.status} — try again in a moment.`
        : `That server answered HTTP ${res.status}.`,
    };
  }
  const unreadable = appEndpoint
    ? "Fastmail returned an unreadable session response."
    : "That URL is not a JMAP session; check the server address.";
  let body: unknown;
  try {
    body = JSON.parse(
      (await readBodyLimited(res, SESSION_MAX_BYTES)).toString("utf8"),
    );
  } catch (err) {
    if (err instanceof SsrfError) {
      return { ok: false, reason: "network", message: err.message };
    }
    return { ok: false, reason: "network", message: unreadable };
  }
  const parsed = sessionResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: "network", message: unreadable };
  }
  const j = parsed.data;
  const mailAccountId = selectMailAccountId(j);
  if (!mailAccountId) {
    return {
      ok: false,
      reason: "no-mail-account",
      message: appEndpoint
        ? "This token has no mail access — recreate it and enable the mail scopes."
        : "This account has no mail access on that server.",
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
 * Verify a JMAP server by loading its session with the given credential.
 * The session URL is normalized first (a bare host becomes the well-known
 * path). `invalid-token` covers 401/403 (bad or revoked credential);
 * anything else (timeout, 5xx, unreadable session) is `network` so the UI
 * can suggest retrying.
 */
export async function verifyJmapServer(
  server: JmapServer,
  fetchImpl?: SessionFetch,
): Promise<JmapTokenVerification> {
  const sessionUrl = resolveJmapSessionUrl(server.sessionUrl);
  return loadSession(
    sessionUrl === server.sessionUrl ? server : { ...server, sessionUrl },
    fetchImpl,
  );
}

/**
 * Verify a user-supplied Fastmail API token by loading its JMAP session.
 * Thin wrapper over `verifyJmapServer` pinning the app's own endpoint.
 */
export async function verifyJmapToken(
  token: string,
): Promise<JmapTokenVerification> {
  return verifyJmapServer({
    sessionUrl: FASTMAIL_SESSION_URL,
    authorization: `Bearer ${token}`,
  });
}

/** A JMAP method-level error with its RFC 8620 error `type` preserved, so
 * callers can tolerate a method a server does not implement (push,
 * Email/import) without matching message text. `message` overrides the
 * default text where a call site has a more specific, long-standing
 * message (the per-object /set failures). */
export class JmapMethodError extends Error {
  constructor(
    readonly method: string,
    readonly type: string,
    detail: unknown,
    message?: string,
  ) {
    super(message ?? `JMAP ${method} error: ${JSON.stringify(detail)}`);
    this.name = "JmapMethodError";
  }
}

// --- Per-token JMAP calls ----------------------------------------------------

const sessionCache = new Map<string, Promise<JmapTokenInfo>>();

/** A server's cache key: the endpoint plus the credential, so two accounts
 * on one server never share a session. */
function serverCacheKey(server: JmapServer): string {
  return `${server.sessionUrl}\n${server.authorization}`;
}

/** The JMAP session for a server, cached per server+credential (per
 * serverless instance). A failed lookup is evicted so the next call
 * retries. */
export async function jmapSessionForToken(
  server: JmapServer,
): Promise<JmapTokenInfo> {
  const key = serverCacheKey(server);
  let cached = sessionCache.get(key);
  if (!cached) {
    cached = loadSession(server).then((r) => {
      if (r.ok) return r.info;
      throw new Error(r.message);
    });
    sessionCache.set(key, cached);
    cached.catch(() => sessionCache.delete(key));
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
 * notDestroyed (the Fastmail gotcha). Shared core behind both clients:
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
  // A malformed 200 (no methodResponses array) must fail as a provider error,
  // not as `undefined is not iterable` here or as a bad `[0]` deref upstream.
  if (!Array.isArray(j.methodResponses) || j.methodResponses.length === 0) {
    throw new Error("JMAP returned no method responses");
  }
  for (const [name, args] of j.methodResponses) {
    if (name === "error") {
      throw new JmapMethodError(name, failureType(args) ?? "unknown", args);
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
            (f) => failureType(f) !== "notFound",
          );
          if (hardFailures.length === 0) continue;
        }
        throw new JmapMethodError(
          name,
          firstFailureType(failures) ?? "unknown",
          failures,
          `JMAP ${name} ${key}: ${JSON.stringify(failures)}`,
        );
      }
    }
  }
  return j.methodResponses;
}

/** The RFC 8620 error `type` of a JMAP failure object, when it carries one
 * as a string. */
function failureType(value: unknown): string | undefined {
  if (value && typeof value === "object" && "type" in value) {
    const type = value.type;
    if (typeof type === "string") return type;
  }
  return undefined;
}

/** The error `type` of a /set failure map's first typed entry. */
function firstFailureType(
  failures: Record<string, unknown>,
): string | undefined {
  for (const failure of Object.values(failures)) {
    const type = failureType(failure);
    if (type) return type;
  }
  return undefined;
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
 * POST a batch of JMAP method calls with a server credential; throws on the
 * first per-call error, including per-object /set failures surfaced via
 * notUpdated/notCreated/notDestroyed (the Fastmail gotcha the app's own
 * client, fastmail.server.ts, documents).
 */
export async function jmapCall(
  server: JmapServer,
  methodCalls: unknown[][],
  capabilities: JmapCapability[] = [],
  opts: { tolerateNotFoundDestroy?: boolean } = {},
): Promise<[string, unknown, string][]> {
  const s = await jmapSessionForToken(server);
  return jmapBatch(
    s.apiUrl,
    server.authorization,
    methodCalls,
    capabilities,
    opts,
  );
}

// --- PushSubscription + Email/import (shared by both auth flavors) ----------

/** A Fastmail push subscription (PushSubscription/get). */
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
  server: JmapServer,
): Promise<PushSubscriptionInfo[]> {
  const responses = await jmapCall(server, [
    ["PushSubscription/get", {}, "m0"],
  ]);
  // JMAP methodResponses arrive as untyped wire tuples; assert the args
  // shape once per call and read typed fields from the named const.
  const args = responses[0]![1] as PushListArgs;
  return args.list ?? [];
}

/** Create a push subscription (PushSubscription/set); returns the new id.
 * Throws when Fastmail rejects the create. */
export async function jmapPushCreate(
  server: JmapServer,
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
    server,
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

/** Echo the server's PushVerification code back (completes the handshake). */
export async function jmapPushVerify(
  server: JmapServer,
  subscriptionId: string,
  code: string,
  jmapOpts: { tolerateNotFoundDestroy?: boolean } = {},
): Promise<void> {
  await jmapCall(
    server,
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
  server: JmapServer,
  subscriptionId: string,
  jmapOpts: { tolerateNotFoundDestroy?: boolean } = {},
): Promise<void> {
  await jmapCall(
    server,
    [["PushSubscription/set", { destroy: [subscriptionId] }, "m0"]],
    [],
    jmapOpts,
  );
}

/** Import a raw message blob into a mailbox (Email/import); returns the new
 * email id. Shared by the receipts pipeline's Sent-box write and the
 * connected accounts' Inbox write. */
export async function jmapImportEmail(
  server: JmapServer,
  opts: { blobId: string; mailboxId: string },
): Promise<string> {
  const responses = await jmapCall(server, [
    [
      "Email/import",
      {
        accountId: (await jmapSessionForToken(server)).mailAccountId,
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

const jmapAddressSchema = z.object({
  // RFC 8621 EmailAddress.name is String|null: Fastmail sends null when a
  // participant has no display name (EXPENSE-X: name:null killed the whole
  // Email/get parse). email stays optional: formatAddress maps a missing
  // address to null and the callers tolerate it.
  name: z.string().nullish(),
  email: z.string().nullish(),
});

/** RFC 8621 Email/get shape for the properties both raw-email readers
 * request. Message-ID is String[] (the header can repeat); a bare string
 * is tolerated because test mocks and smaller JMAP servers have shipped
 * both. The rest is nullable: JMAP returns null for absent headers. */
const jmapEmailMetadataSchema = z.object({
  blobId: z.string().nullish(),
  receivedAt: z.string().nullish(),
  subject: z.string().nullish(),
  from: z.array(jmapAddressSchema).nullish(),
  to: z.array(jmapAddressSchema).nullish(),
  messageId: z.union([z.array(z.string()), z.string()]).nullish(),
});
export type EmailMetadata = z.infer<typeof jmapEmailMetadataSchema>;

/** Email/get for one message id, zod-validated at the wire boundary. This
 * is where Fastmail's real response shape enters the app (EXPENSE-S: the
 * String[] messageId was typed as string, reached the reply envelope, and
 * killed every confirmation send with "value.replace is not a function").
 * A missing id returns undefined (fetchRawRfc822 turns that into "Email
 * not found"); a response that doesn't match the schema throws, so the
 * next wire-format surprise is loud instead of a swallowed warning. */
export async function getEmailMetadata(opts: {
  server: JmapServer;
  accountId: string;
  id: string;
}): Promise<EmailMetadata | undefined> {
  const responses = await jmapCall(opts.server, [
    [
      "Email/get",
      {
        accountId: opts.accountId,
        ids: [opts.id],
        properties: [
          "blobId",
          "receivedAt",
          "subject",
          "from",
          "to",
          "messageId",
        ],
      },
      "m0",
    ],
  ]);
  const parsed = z
    .object({ list: z.array(jmapEmailMetadataSchema) })
    .safeParse(responses[0]![1]);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Email/get response shape mismatch: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data.list[0];
}

/** The common shape of a downloaded RFC 5322 email; both raw-email
 * transports return it. fastmail.server (RawEmail) and
 * email-connection-mail.server (RawConnectionEmail) alias this type, and
 * fetchRawRfc822 is the one place that builds it. */
export interface RawRfc822Email {
  id: string;
  raw: Buffer;
  receivedAt: string;
  subject: string;
  /** First From address, formatted "Name <email>" (or bare email, or null). */
  from: string | null;
  /** All To addresses as formatted strings. */
  to: string[];
  /** Message-ID header, if present. */
  messageId: string;
}

/** Download an email's RFC 5322 blob and map its metadata to the common
 * shape. Shared by both transports (the app's mailbox and connected
 * accounts); the caller owns the Email/get lookup and the auth headers.
 * The top-level Email blob is the full RFC 5322 message; Fastmail serves it
 * for both message/rfc822 and application/octet-stream. */
export async function fetchRawRfc822(opts: {
  id: string;
  email: EmailMetadata | undefined;
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
    messageId: Array.isArray(email.messageId)
      ? (email.messageId[0] ?? "")
      : (email.messageId ?? ""),
  };
}
