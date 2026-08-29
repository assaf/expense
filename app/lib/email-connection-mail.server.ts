import {
  buildRfc822Message,
  type SendEmailInput,
} from "~/lib/email-mime.server";
import {
  fetchRawRfc822,
  formatAddress,
  jmapCall,
  jmapImportEmail,
  jmapSessionForToken,
  jmapUploadBlob,
  type JmapTokenInfo,
} from "~/lib/jmap.server";

/**
 * Mail operations on a CONNECTED email account, all authenticated as the
 * user with their stored API token (distinct from fastmail.server.ts, the
 * app's own mailbox): query the Inbox, read emails (full RFC 5322), move
 * an email to Trash, and send email from the user's own identity (the
 * processing pipeline's confirmation notifications).
 *
 * JMAP account ids are per-provider-account and the session's
 * primaryAccounts entry is already bound to the token, so jmapCall's
 * `using` capabilities drive everything; the mail account id is only
 * needed for Mailbox/Email calls that require it explicitly.
 */

// --- Mailboxes ---------------------------------------------------------------

interface MailboxList {
  list: Array<{ id: string; name?: string; role?: string }>;
}

/** Resolve a mailbox id by its role ("inbox", "trash"); shared with the
 * rule-inference scan, which reads the Inbox the same way. */
export async function mailboxIdByRole(
  token: string,
  role: string,
): Promise<string> {
  const responses = await jmapCall(token, [
    [
      "Mailbox/get",
      {
        accountId: (await jmapSessionForToken(token)).mailAccountId,
        ids: null,
        properties: ["id", "role"],
      },
      "m0",
    ],
  ]);
  const args = responses[0]![1] as MailboxList;
  const box = args.list.find((b) => b.role === role);
  if (!box) throw new Error(`No mailbox with role "${role}"`);
  return box.id;
}

// --- Inbox query --------------------------------------------------------------

export interface ConnectionEmailSummary {
  id: string;
  receivedAt: string;
  subject: string;
  from: string | null;
  /** First ~50 words of the body; present only when the query asked for
   * it (opts.includePreview). */
  preview?: string;
}

/**
 * Recent emails in a mailbox (by role). The drain passes an `afterIso`
 * lookback window (oldest first); the review scan passes `descending`
 * with its own 90-day `afterIso`, newest first. Already-evaluated emails
 * are skipped by the caller via the EmailProcessLog (idempotency), not by
 * the query.
 */
export async function mailboxSummaries(opts: {
  token: string;
  role: string;
  /** Lower bound on receivedAt (exclusive): the drain's lookback window. */
  afterIso?: string;
  limit: number;
  /** Newest-first (default: oldest-first, the drain's cursor contract). */
  descending?: boolean;
  /** Also fetch the body preview (the rule-inference scan's classifier
   * input). Off by default: previews cost extra wire bytes. */
  includePreview?: boolean;
}): Promise<ConnectionEmailSummary[]> {
  const mailboxId = await mailboxIdByRole(opts.token, opts.role);
  const query = await jmapCall(opts.token, [
    [
      "Email/query",
      {
        accountId: (await jmapSessionForToken(opts.token)).mailAccountId,
        filter: {
          inMailbox: mailboxId,
          ...(opts.afterIso ? { after: opts.afterIso } : {}),
        },
        sort: [{ property: "receivedAt", isAscending: !opts.descending }],
        limit: opts.limit,
      },
      "m0",
    ],
  ]);
  const ids = (query[0]![1] as { ids?: string[] }).ids ?? [];
  if (ids.length === 0) return [];
  const got = await jmapCall(opts.token, [
    [
      "Email/get",
      {
        accountId: (await jmapSessionForToken(opts.token)).mailAccountId,
        ids,
        properties: [
          "id",
          "receivedAt",
          "subject",
          "from",
          ...(opts.includePreview ? ["preview"] : []),
        ],
      },
      "m0",
    ],
  ]);
  const list = (got[0]![1] as { list?: unknown[] }).list ?? [];
  return list.map((e) => {
    const email = e as {
      id: string;
      receivedAt?: string;
      subject?: string;
      from?: Array<{ name?: string; email?: string }>;
      preview?: string;
    };
    const first = email.from?.[0];
    return {
      id: email.id,
      receivedAt: email.receivedAt ?? new Date().toISOString(),
      subject: email.subject ?? "",
      from: formatAddress(first),
      ...(opts.includePreview ? { preview: email.preview ?? "" } : {}),
    };
  });
}

/** Inbox summaries (role = "inbox"). Retained for the default adapter. */
export function inboxEmailSummaries(opts: {
  token: string;
  afterIso?: string;
  limit: number;
  descending?: boolean;
}): Promise<ConnectionEmailSummary[]> {
  return mailboxSummaries({ ...opts, role: "inbox" });
}

// --- Raw email ----------------------------------------------------------------

export interface RawConnectionEmail {
  id: string;
  raw: Buffer;
  receivedAt: string;
  subject: string;
  from: string | null;
  to: string[];
  messageId: string;
}

/** The full RFC 5322 source of an email (blob download), plus metadata. */
export async function rawConnectionEmail(
  token: string,
  id: string,
): Promise<RawConnectionEmail> {
  const s: JmapTokenInfo = await jmapSessionForToken(token);
  const responses = await jmapCall(token, [
    [
      "Email/get",
      {
        accountId: s.mailAccountId,
        ids: [id],
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
  const list = (responses[0]![1] as { list?: unknown[] }).list ?? [];
  const email = list[0] as Parameters<typeof fetchRawRfc822>[0]["email"];
  return fetchRawRfc822({
    id,
    email,
    accountId: s.mailAccountId,
    downloadUrl: s.downloadUrl,
    headers: { Authorization: `Bearer ${token}` },
  });
}

// --- Trash ---------------------------------------------------------------------

/**
 * Move an email to the Trash mailbox (recoverable; the connected-account
 * pipeline never destroys user mail) and mark it read.
 */
export async function moveConnectionEmailToTrash(
  token: string,
  id: string,
): Promise<void> {
  const trashId = await mailboxIdByRole(token, "trash");
  await jmapCall(token, [
    [
      "Email/set",
      {
        accountId: (await jmapSessionForToken(token)).mailAccountId,
        update: {
          [id]: { mailboxIds: { [trashId]: true }, "keywords/$seen": true },
        },
      },
      "m0",
    ],
  ]);
}

/**
 * Deliver an email straight into the account's Inbox by writing it via JMAP
 * Email/import, with no EmailSubmission and no Identity/get. FastMail API tokens
 * can read/write mail but cannot submit (urn:ietf:params:jmap:submission
 * is disallowed, HTTP 403), so a confirmation that goes to the mailbox
 * owner (self) is written as an Inbox message instead of being sent.
 * The owner sees it appear in their Inbox; the expense + Trash already
 * succeeded, so a delivery failure is logged and never fatal.
 */
export async function deliverConnectionEmailToInbox(
  token: string,
  input: SendEmailInput,
  fromAddress: string,
): Promise<boolean> {
  try {
    const inboxId = await mailboxIdByRole(token, "inbox");
    const raw = buildRfc822Message({
      fromName: "",
      fromEmail: fromAddress,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      inReplyTo: input.inReplyTo,
      attachments: input.attachments,
    });
    const blobId = await jmapUploadBlob(
      (await jmapSessionForToken(token)).uploadUrl,
      (await jmapSessionForToken(token)).mailAccountId,
      `Bearer ${token}`,
      raw,
    );
    await jmapImportEmail(token, { blobId, mailboxId: inboxId });
    console.info("[email-connections] confirmation delivered to Inbox", {
      to: input.to,
      subject: input.subject,
    });
    return true;
  } catch (err) {
    console.error(
      `[email-connections] inbox delivery failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { to: input.to, subject: input.subject },
    );
    return false;
  }
}
