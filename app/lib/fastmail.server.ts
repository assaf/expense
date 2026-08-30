import {
  FASTMAIL_TOKEN,
  INBOUND_EMAIL_ADDRESS,
  RECEIPTS_FOLDER,
} from "~/lib/env";
import { captureWarning } from "~/lib/errors.server";
import {
  buildRfc822Message,
  type SendEmailInput,
} from "~/lib/email-mime.server";
import {
  fetchRawRfc822,
  getEmailMetadata,
  jmapBatch,
  jmapImportEmail,
  jmapPushCreate,
  jmapPushDestroy,
  jmapPushList,
  jmapPushVerify,
  jmapSessionForToken,
  jmapUploadBlob,
  type JmapCapability,
  type JmapTokenInfo,
  type PushSubscriptionInfo,
} from "~/lib/jmap.server";

/**
 * Minimal FastMail JMAP client for the receipts-by-email push pipeline.
 *
 * Ported from the inbox project (lib/jmap.ts) with the same hard-won details:
 *  - per-object /set failures come back in `notUpdated`/`notCreated`/
 *    `notDestroyed`, not as a method `error`, and are surfaced as throws
 *  - Fastmail keywords are `$`-prefixed (`$seen`, not RFC `\seen`)
 *  - raw email blobs download from `downloadUrl` with `type=message/rfc822`
 *
 * All functions throw on failure; callers treat throws as "leave the email
 * in the Receipts folder" (the daily cron is the catch-up net).
 */

/** Keyword marking an email as already processed (one-way on Fastmail: it
 * can be set but not removed, so mark-before-process is the idempotency
 * pattern; the inbound_emails table is the second, DB-level guard). */
const RECEIPT_PROCESSED_KEYWORD = "$receipt-processed";
function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${FASTMAIL_TOKEN}` };
}

/** The app mailbox's JMAP session; jmap.server caches it per instance. */
function jmapSession(): Promise<JmapTokenInfo> {
  return jmapSessionForToken(FASTMAIL_TOKEN);
}

/**
 * POST a batch of method calls; throws on the first per-call error.
 * `capabilities` adds to the standard core + mail capabilities. Thin
 * adapter over the shared `jmapBatch` core (jmap.server.ts) with this
 * client's idempotent-delete tolerance.
 */
async function jmapApi(
  methodCalls: unknown[][],
  capabilities: JmapCapability[] = [],
): Promise<[string, unknown, string][]> {
  const s = await jmapSession();
  return jmapBatch(
    s.apiUrl,
    `Bearer ${FASTMAIL_TOKEN}`,
    methodCalls,
    capabilities,
    { tolerateNotFoundDestroy: true },
  );
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
    accountId: s.mailAccountId,
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

/**
 * Fetch the full RFC 5322 source of an email by downloading its blob, plus
 * the metadata the inbound pipeline needs.
 */
export async function rawEmail(id: string): Promise<RawEmail> {
  const s = await jmapSession();
  const email = await getEmailMetadata({
    token: FASTMAIL_TOKEN,
    accountId: s.mailAccountId,
    id,
  });
  return fetchRawRfc822({
    id,
    email,
    accountId: s.mailAccountId,
    downloadUrl: s.downloadUrl,
    headers: bearer(),
  });
}

/** True when an Email/get miss means the email is already gone: a
 * concurrent drain destroyed it between listing and fetching. The drain
 * treats that as the desired end state, not an error (EXPENSE-K). */
export function isEmailNotFoundError(err: unknown): boolean {
  return err instanceof Error && /^Email \S+ not found$/.test(err.message);
}

/** True when an Email/set update reports the email as already gone: a
 * concurrent drain destroyed it between this drain's fetch and its
 * mark-processed call. Processed is the desired end state, not an
 * error (EXPENSE-T). */
export function isEmailUpdateGoneError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.startsWith("JMAP Email/set notUpdated:") &&
    err.message.includes('"type":"notFound"')
  );
}

/**
 * Query receipt emails in the Receipts folder that have not been processed
 * yet (oldest first). `inMailbox` scopes the query to the folder the rule
 * files into; the Inbox never sees these.
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
    accountId: s.mailAccountId,
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
/**
 * One bounded retry for a receipt email whose pipeline failed: clear the
 * processed keyword (so the next drain re-enumerates it) and mark it
 * retried. A SECOND failure flips it to permanently skipped — unbounded
 * retries of a poison email would block the receivedAt-ordered queue.
 */
export async function markReceiptRetry(id: string): Promise<void> {
  const s = await jmapSession();
  const { list } = await call<
    { accountId: string; ids: string[]; properties: string[] },
    { list: Array<{ keywords?: Record<string, boolean> }> }
  >("Email/get", {
    accountId: s.mailAccountId,
    ids: [id],
    properties: ["keywords"],
  });
  const keywords: Record<string, boolean> = { ...list[0]?.keywords };
  if (keywords["$receipt-retried"]) {
    await markReceiptProcessed(id);
    return;
  }
  delete keywords[RECEIPT_PROCESSED_KEYWORD];
  keywords["$receipt-retried"] = true;
  await call<{ accountId: string; update: Record<string, unknown> }, unknown>(
    "Email/set",
    {
      accountId: s.mailAccountId,
      update: { [id]: { keywords } },
    },
  );
}

export async function markReceiptProcessed(id: string): Promise<void> {
  const s = await jmapSession();
  await call<{ accountId: string; update: Record<string, unknown> }, unknown>(
    "Email/set",
    {
      accountId: s.mailAccountId,
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
    accountId: s.mailAccountId,
    destroy: [id],
  });
}

// --- Push subscriptions ------------------------------------------------------

export async function listSubscriptions(): Promise<PushSubscriptionInfo[]> {
  return jmapPushList(FASTMAIL_TOKEN);
}

export async function createSubscription(opts: {
  url: string;
  p256dh: string;
  auth: string;
  deviceClientId: string;
  expires: string;
}): Promise<string> {
  return jmapPushCreate(FASTMAIL_TOKEN, opts, {
    tolerateNotFoundDestroy: true,
  });
}

export async function setVerificationCode(
  id: string,
  code: string,
): Promise<void> {
  return jmapPushVerify(FASTMAIL_TOKEN, id, code, {
    tolerateNotFoundDestroy: true,
  });
}

export async function destroySubscription(id: string): Promise<void> {
  return jmapPushDestroy(FASTMAIL_TOKEN, id, {
    tolerateNotFoundDestroy: true,
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
  >("Identity/get", { accountId: (await jmapSession()).mailAccountId }, [
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
 * identity (`*@domain`): receipts@labnotes.org matches `*@labnotes.org`.
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

/** Upload a raw RFC 5322 message blob; returns the blobId. Thin adapter
 * over the shared `jmapUploadBlob` (jmap.server.ts). */
async function uploadBlob(raw: Buffer): Promise<string> {
  const s = await jmapSession();
  return jmapUploadBlob(
    s.uploadUrl,
    s.mailAccountId,
    `Bearer ${FASTMAIL_TOKEN}`,
    raw,
  );
}

/** Submit a message for sending (Fastmail delivers via SMTP). Fastmail
 * implements the RFC 8621 `EmailSubmission/set` method (not `Email/submit`). */
async function submitEmail(identityId: string, emailId: string): Promise<void> {
  await call<{ accountId: string; create: Record<string, unknown> }, unknown>(
    "EmailSubmission/set",
    {
      accountId: (await jmapSession()).mailAccountId,
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

/** The JMAP send flow's collaborators, injectable so tests exercise the
 * whole identity→upload→import→submit sequence offline. `fromAddress`
 * overrides the receipts address when provided. */
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
  importEmail: (blobId: string, mailboxId: string) =>
    jmapImportEmail(FASTMAIL_TOKEN, { blobId, mailboxId }),
  submitEmail,
};

/**
 * True when a submission failure is ambiguous: the request may have been
 * processed by FastMail with only the response lost (fetch timeout, dropped
 * connection). Retrying such a failure can deliver a second copy of the
 * same message; explicit server rejections (HTTP/JMAP errors) are the only
 * failures where the submission is known not to exist and a retry is safe.
 */
function isAmbiguousSubmitFailure(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name ?? "";
    if (name === "TimeoutError" || /abort|timed? ?out/i.test(err.message)) {
      return true;
    }
    // fetch() network-level failure (connection refused/reset, DNS, …);
    // the request may or may not have reached FastMail.
    if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
      return true;
    }
  }
  return false;
}

/** Build the RFC 5322 message bytes for a reply and send it from the
 * account via JMAP `EmailSubmission/set`. Returns false (after logging) on
 * any failure; callers must never fail because email did. */
export async function sendEmailViaJmap(
  input: SendEmailInput,
  deps: JmapSendDeps = realJmapSendDeps,
): Promise<boolean> {
  try {
    const identities = await deps.listIdentities();
    const fromAddress = deps.fromAddress ?? INBOUND_EMAIL_ADDRESS;
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
    try {
      await deps.submitEmail(chosen.id, emailId);
    } catch (err) {
      // A transient submission failure would otherwise drop the reply
      // forever: a lost confirmation makes the sender re-forward, which
      // creates a duplicate expense. Retry once with the SAME emailId: the
      // blob upload and Sent-mailbox import already succeeded, so only the
      // submission repeats.
      //
      // BUT the retry is only safe when the server explicitly rejected the
      // request (an HTTP/JMAP error response means the submission is known
      // NOT to exist). When the request timed out or the connection
      // dropped, the first attempt may have landed with only the response
      // lost; FastMail deletes EmailSubmission records after delivery, so
      // there is no way to tell, and re-submitting the same email delivers
      // a SECOND copy (observed in the wild: identical Message-IDs in the
      // recipient's Inbox, one confirmation per submit). Those ambiguous
      // failures are logged and NOT retried (the expense is already
      // saved, and the more likely outcome is that the reply was delivered).
      const message = err instanceof Error ? err.message : String(err);
      if (isAmbiguousSubmitFailure(err)) {
        console.warn(
          `[email] submit outcome unknown (may already be delivered), NOT retrying: ${message}`,
          { to: input.to, subject: input.subject },
        );
      } else {
        console.warn(`[email] submit rejected, retrying once: ${message}`, {
          to: input.to,
          subject: input.subject,
        });
        await deps.submitEmail(chosen.id, emailId);
      }
    }
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
