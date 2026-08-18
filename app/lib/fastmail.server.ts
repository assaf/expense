import { FASTMAIL_TOKEN, FASTMAIL_FROM, RECEIPTS_FOLDER } from "~/lib/env";
import { captureWarning } from "~/lib/errors.server";
import {
  buildRfc822Message,
  type SendEmailInput,
} from "~/lib/email-mime.server";

/**
 * Minimal FastMail JMAP client for the receipts-by-email push pipeline.
 *
 * Ported from the inbox project (lib/jmap.ts) — same hard-won details:
 *  - per-object /set failures come back in `notUpdated`/`notCreated`/
 *    `notDestroyed`, not as a method `error`, and are surfaced as throws
 *  - Fastmail keywords are `$`-prefixed (`$seen`, not RFC `\seen`)
 *  - raw email blobs download from `downloadUrl` with `type=message/rfc822`
 *
 * All functions throw on failure; callers treat throws as "leave the email
 * in the Receipts folder" (the daily cron is the catch-up net).
 */

const SESSION_URL = "https://api.fastmail.com/jmap/session";
const REQUEST_TIMEOUT_MS = 30_000;

/** Keyword marking an email as already processed (one-way on Fastmail — it
 * can be set but not removed, so mark-before-process is the idempotency
 * pattern; the inbound_emails table is the second, DB-level guard). */
const RECEIPT_PROCESSED_KEYWORD = "$receipt-processed";

interface Session {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  accountId: string;
  username: string;
}

interface SessionResponse {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  username: string;
  primaryAccounts: Record<string, string>;
}

let sessionCache: Session | null = null;
let sessionPromise: Promise<Session> | null = null;

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${FASTMAIL_TOKEN}` };
}

async function jmapSession(): Promise<Session> {
  if (sessionCache) return sessionCache;
  sessionPromise ??= (async () => {
    const res = await fetch(SESSION_URL, {
      headers: bearer(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`JMAP session failed: ${res.status} ${await res.text()}`);
    }
    const j = (await res.json()) as SessionResponse;
    const accountId = j.primaryAccounts["urn:ietf:params:jmap:mail"];
    if (!accountId) throw new Error("JMAP session missing mail account");
    sessionCache = {
      apiUrl: j.apiUrl,
      uploadUrl: j.uploadUrl,
      downloadUrl: j.downloadUrl,
      accountId,
      username: j.username,
    };
    return sessionCache;
  })();
  return sessionPromise;
}

interface ApiResponse {
  methodResponses: [string, unknown, string][];
}

/** Extra JMAP capabilities beyond core + mail (e.g. submission for sending). */
type JmapCapability = "urn:ietf:params:jmap:submission";

/**
 * POST a batch of method calls; throws on the first per-call error.
 * `capabilities` adds to the standard core + mail capabilities.
 */
async function jmapApi(
  methodCalls: unknown[][],
  capabilities: JmapCapability[] = [],
): Promise<[string, unknown, string][]> {
  const s = await jmapSession();
  const res = await fetch(s.apiUrl, {
    method: "POST",
    headers: {
      ...bearer(),
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
    // A /set or /import call can "succeed" while individual objects fail
    // (notUpdated/notCreated/notDestroyed). Fastmail reports invalid keyword
    // paths this way — surface it instead of silently dropping work.
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

/** Unwrap the args of the first method response. */
function firstArgs(responses: [string, unknown, string][]): unknown {
  const first = responses[0];
  if (!first) throw new Error("JMAP returned no method responses");
  return first[1];
}

async function call<Args, Result>(
  name: string,
  args: Args,
  capabilities?: JmapCapability[],
): Promise<Result> {
  return firstArgs(await jmapApi([[name, args, "m0"]], capabilities)) as Result;
}

interface Mailbox {
  id: string;
  name: string;
}

async function listMailboxes(): Promise<Mailbox[]> {
  const s = await jmapSession();
  const { list } = await call<
    { accountId: string; ids: null; properties: string[] },
    { list: Mailbox[] }
  >("Mailbox/get", {
    accountId: s.accountId,
    ids: null,
    properties: ["id", "name"],
  });
  return list;
}

let mailboxNameCache: Map<string, string> | null = null;

/** Find the mailbox id for a folder name (case-insensitive), cached. */
async function mailboxIdByName(name: string): Promise<string> {
  if (!mailboxNameCache) {
    const boxes = await listMailboxes();
    mailboxNameCache = new Map(boxes.map((b) => [b.name.toLowerCase(), b.id]));
  }
  const id = mailboxNameCache.get(name.toLowerCase());
  if (!id) {
    throw new Error(`No Fastmail folder named "${name}" found`);
  }
  return id;
}

/** The folder the delivery rule files receipt mail into. */
async function receiptsMailboxId(): Promise<string> {
  return mailboxIdByName(RECEIPTS_FOLDER);
}

export interface RawEmail {
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

function formatAddress(
  a?: { name?: string; email?: string } | null,
): string | null {
  if (!a?.email) return null;
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

/**
 * Fetch the full RFC 5322 source of an email by downloading its blob, plus
 * the metadata the inbound pipeline needs.
 */
export async function rawEmail(id: string): Promise<RawEmail> {
  const s = await jmapSession();
  const { list } = await call<
    { accountId: string; ids: string[]; properties: string[] },
    {
      list: Array<{
        blobId?: string;
        receivedAt?: string;
        subject?: string;
        from?: Array<{ name?: string; email?: string }>;
        to?: Array<{ name?: string; email?: string }>;
        messageId?: string;
      }>;
    }
  >("Email/get", {
    accountId: s.accountId,
    ids: [id],
    properties: ["blobId", "receivedAt", "subject", "from", "to", "messageId"],
  });
  const email = list[0];
  if (!email) throw new Error(`Email ${id} not found`);

  // The top-level Email blob is the full RFC 5322 message; Fastmail serves
  // it for both message/rfc822 and application/octet-stream.
  const url = s.downloadUrl
    .replace("{accountId}", s.accountId)
    .replace("{blobId}", email.blobId ?? "")
    .replace("{name}", "email.eml")
    .replace("{type}", "message/rfc822");

  const res = await fetch(url, {
    headers: bearer(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`email download failed: ${res.status} ${await res.text()}`);
  }
  return {
    id,
    raw: Buffer.from(await res.arrayBuffer()),
    receivedAt: email.receivedAt ?? new Date().toISOString(),
    subject: email.subject ?? "",
    from: formatAddress(email.from?.[0]),
    to: (email.to ?? []).map((a) => formatAddress(a) ?? "").filter(Boolean),
    messageId: email.messageId ?? "",
  };
}

/**
 * Query receipt emails in the Receipts folder that have not been processed
 * yet (oldest first). `inMailbox` scopes the query to the folder the rule
 * files into — the Inbox never sees these.
 */
export async function unprocessedReceiptIds(limit: number): Promise<string[]> {
  const s = await jmapSession();
  const mailboxId = await receiptsMailboxId();
  const { ids } = await call<
    {
      accountId: string;
      filter: { inMailbox: string; notKeyword: string };
      sort: Array<{ property: string; isAscending: boolean }>;
      limit: number;
    },
    { ids: string[] }
  >("Email/query", {
    accountId: s.accountId,
    filter: {
      inMailbox: mailboxId,
      notKeyword: RECEIPT_PROCESSED_KEYWORD,
    },
    sort: [{ property: "receivedAt", isAscending: true }],
    limit,
  });
  return ids;
}

/** Mark a receipt email as processed + read (both `$`-keywords). */
export async function markReceiptProcessed(id: string): Promise<void> {
  const s = await jmapSession();
  await call<{ accountId: string; update: Record<string, unknown> }, unknown>(
    "Email/set",
    {
      accountId: s.accountId,
      update: {
        [id]: {
          [`keywords/${RECEIPT_PROCESSED_KEYWORD}`]: true,
          "keywords/$seen": true,
        },
      },
    },
  );
}

/** Permanently delete a receipt email after a successful import. */
export async function destroyEmail(id: string): Promise<void> {
  const s = await jmapSession();
  await call<{ accountId: string; destroy: string[] }, unknown>("Email/set", {
    accountId: s.accountId,
    destroy: [id],
  });
}

// --- Push subscriptions ------------------------------------------------------

export interface PushSubscription {
  id: string;
  deviceClientId: string;
  expires: string | null;
  url: string;
}

export async function listSubscriptions(): Promise<PushSubscription[]> {
  const { list } = await call<
    Record<string, never>,
    { list: PushSubscription[] }
  >("PushSubscription/get", {});
  return list;
}

export async function createSubscription(opts: {
  url: string;
  p256dh: string;
  auth: string;
  deviceClientId: string;
  expires: string;
}): Promise<string> {
  const { created } = await call<
    { create: Record<string, unknown> },
    { created: Record<string, { id: string }> }
  >("PushSubscription/set", {
    create: {
      sub1: {
        deviceClientId: opts.deviceClientId,
        url: opts.url,
        types: ["Email"],
        keys: { p256dh: opts.p256dh, auth: opts.auth },
        expires: opts.expires,
      },
    },
  });
  return created["sub1"]?.id ?? "";
}

export async function setVerificationCode(
  id: string,
  code: string,
): Promise<void> {
  await call<{ update: Record<string, unknown> }, unknown>(
    "PushSubscription/set",
    {
      update: { [id]: { verificationCode: code } },
    },
  );
}

export async function destroySubscription(id: string): Promise<void> {
  await call<{ destroy: string[] }, unknown>("PushSubscription/set", {
    destroy: [id],
  });
}

// --- Sending (EmailSubmission/set) ------------------------------------------

export interface FastmailIdentity {
  id: string;
  name: string;
  email: string;
  /** The mailbox the identity saves sent mail to (e.g. the Sent folder). */
  saveSentToMailboxId: string;
}

/** The account's sending identities (Identity/get). */
async function listIdentities(): Promise<FastmailIdentity[]> {
  // Fastmail gates Identity/get behind the submission capability.
  const { list } = await call<
    { accountId: string },
    {
      list: Array<{
        id: string;
        name?: string;
        email?: string;
        saveSentToMailboxId?: string;
      }>;
    }
  >("Identity/get", { accountId: (await jmapSession()).accountId }, [
    "urn:ietf:params:jmap:submission",
  ]);
  return list
    .filter((i) => i.email)
    .map((i) => ({
      id: i.id,
      name: i.name ?? "",
      email: i.email!,
      saveSentToMailboxId: i.saveSentToMailboxId ?? "",
    }));
}

/**
 * The identity for an address: exact match first, then a Fastmail wildcard
 * identity (`*@domain`) — receipts@labnotes.org matches `*@labnotes.org`.
 */
function matchIdentity(
  identities: FastmailIdentity[],
  address: string,
): FastmailIdentity | undefined {
  const lower = address.toLowerCase();
  return (
    identities.find((i) => i.email.toLowerCase() === lower) ??
    identities.find((i) => {
      const at = i.email.indexOf("@");
      return (
        i.email.startsWith("*@") &&
        i.email.slice(at + 1).toLowerCase() ===
          lower.slice(lower.indexOf("@") + 1)
      );
    })
  );
}

/** Upload a raw RFC 5322 message blob; returns the blobId. */
async function uploadBlob(raw: Buffer): Promise<string> {
  const s = await jmapSession();
  const url = s.uploadUrl.replace("{accountId}", s.accountId);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...bearer(),
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

/** Import a sent message into the given mailbox (the identity's Sent box). */
async function importEmail(blobId: string, mailboxId: string): Promise<string> {
  const s = await jmapSession();
  const { created } = await call<
    { accountId: string; emails: Record<string, unknown> },
    { created: Record<string, { id: string } | null> }
  >("Email/import", {
    accountId: s.accountId,
    emails: {
      e1: {
        blobId,
        mailboxIds: mailboxId ? { [mailboxId]: true } : {},
      },
    },
  });
  const email = created["e1"];
  if (!email) throw new Error("Email/import did not create the message");
  return email.id;
}

/** Submit a message for sending (Fastmail delivers via SMTP). Fastmail
 * implements the RFC 8621 `EmailSubmission/set` method (not `Email/submit`). */
async function submitEmail(identityId: string, emailId: string): Promise<void> {
  await call<{ accountId: string; create: Record<string, unknown> }, unknown>(
    "EmailSubmission/set",
    {
      accountId: (await jmapSession()).accountId,
      create: {
        k1: {
          identityId,
          emailId,
        },
      },
    },
    ["urn:ietf:params:jmap:submission"],
  );
}

/** The JMAP send flow's collaborators — injectable so tests exercise the
 * whole identity→upload→import→submit sequence offline. `fromAddress`
 * overrides FASTMAIL_FROM when provided. */
export interface JmapSendDeps {
  listIdentities(): Promise<FastmailIdentity[]>;
  uploadBlob(raw: Buffer): Promise<string>;
  importEmail(blobId: string, mailboxId: string): Promise<string>;
  submitEmail(identityId: string, emailId: string): Promise<void>;
  fromAddress?: string;
}

const realJmapSendDeps: JmapSendDeps = {
  listIdentities,
  uploadBlob,
  importEmail,
  submitEmail,
};

/** Build the RFC 5322 message bytes for a reply and send it from the
 * account via JMAP `EmailSubmission/set`. Returns false (after logging) on
 * any failure — callers must never fail because email did. */
export async function sendEmailViaJmap(
  input: SendEmailInput,
  deps: JmapSendDeps = realJmapSendDeps,
): Promise<boolean> {
  try {
    const identities = await deps.listIdentities();
    const fromAddress = deps.fromAddress ?? FASTMAIL_FROM;
    const identity = fromAddress
      ? matchIdentity(identities, fromAddress)
      : undefined;
    const chosen = identity ?? identities[0];
    if (!chosen) {
      console.warn("[email] send skipped: no Fastmail identity found");
      return false;
    }
    const raw = buildRfc822Message({
      fromName: chosen.name,
      fromEmail: chosen.email,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      inReplyTo: input.inReplyTo,
      attachments: input.attachments,
    });
    const blobId = await deps.uploadBlob(raw);
    const emailId = await deps.importEmail(blobId, chosen.saveSentToMailboxId);
    await deps.submitEmail(chosen.id, emailId);
    return true;
  } catch (err) {
    captureWarning(
      `[email] Fastmail send failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { to: input.to, subject: input.subject },
    );
    return false;
  }
}
