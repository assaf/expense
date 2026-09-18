import { z } from "zod";
import {
  buildRfc822Message,
  type SendEmailInput,
} from "~/lib/email-mime.server";
import { authservIdsIn } from "~/lib/email-auth.server";
import {
  fetchRawRfc822,
  formatAddress,
  getEmailMetadata,
  jmapCall,
  jmapImportEmail,
  jmapSessionForToken,
  jmapUploadBlob,
  serverLabel,
  type JmapServer,
  type JmapTokenInfo,
  type RawRfc822Email,
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
 * rule-inference scan, which reads the Inbox the same way. Throws when the
 * server has no mailbox with that role. */
export async function mailboxIdByRole(
  server: JmapServer,
  role: string,
): Promise<string> {
  const responses = await jmapCall(server, [
    [
      "Mailbox/get",
      {
        accountId: (await jmapSessionForToken(server)).mailAccountId,
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

/** Like `mailboxIdByRole`, but undefined instead of a throw when the server
 * has no such role (RFC 8621 §2.5: no role is required to exist). Used
 * where a missing role only skips an optional step (the Trash move). */
export async function tryMailboxIdByRole(
  server: JmapServer,
  role: string,
): Promise<string | undefined> {
  try {
    return await mailboxIdByRole(server, role);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.startsWith("No mailbox with role ")
    ) {
      return undefined;
    }
    throw err;
  }
}

/** Learn the authserv-id of the mailbox's delivery stamp from the newest
 * clause-bearing Authentication-Results header of a recent email. Returns
 * undefined when the mailbox is empty, has no stamped mail yet, or the
 * server does not expose header properties. */
export async function learnAuthservId(
  server: JmapServer,
  accountId: string,
): Promise<string | undefined> {
  try {
    const inboxId = await tryMailboxIdByRole(server, "inbox");
    if (!inboxId) return undefined;
    const query = await jmapCall(server, [
      [
        "Email/query",
        {
          accountId,
          filter: { inMailbox: inboxId },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: 5,
        },
        "m0",
      ],
    ]);
    const ids = (query[0]![1] as { ids?: string[] }).ids ?? [];
    if (ids.length === 0) return undefined;
    const got = await jmapCall(server, [
      [
        "Email/get",
        {
          accountId,
          ids,
          properties: ["header:Authentication-Results:asText"],
        },
        "m0",
      ],
    ]);
    const list = (got[0]![1] as { list?: unknown[] }).list ?? [];
    const records: string[] = [];
    for (const row of list) {
      if (!row || typeof row !== "object") continue;
      const header =
        "header:Authentication-Results:asText" in row
          ? row["header:Authentication-Results:asText"]
          : undefined;
      if (!Array.isArray(header)) continue;
      for (const value of header) {
        if (typeof value === "string") records.push(value);
      }
    }
    return authservIdsIn(records)[0];
  } catch (err) {
    console.warn("[email-connection] could not learn the delivery stamp", {
      err,
    });
    return undefined;
  }
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
  server: JmapServer;
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
  const mailboxId = await mailboxIdByRole(opts.server, opts.role);
  const query = await jmapCall(opts.server, [
    [
      "Email/query",
      {
        accountId: (await jmapSessionForToken(opts.server)).mailAccountId,
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
  const got = await jmapCall(opts.server, [
    [
      "Email/get",
      {
        accountId: (await jmapSessionForToken(opts.server)).mailAccountId,
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
  return parseEmailSummaries(got[0]![1], {
    includePreview: Boolean(opts.includePreview),
  });
}

/** One Email/get row of the listing. Header fields are String|null per
 * RFC 8621; preview is present only when the query asked for it, so it is
 * nullish here for both request shapes. */
const connectionEmailRowSchema = z.object({
  id: z.string(),
  receivedAt: z.string().nullish(),
  subject: z.string().nullish(),
  from: z
    .array(
      z.object({ name: z.string().nullish(), email: z.string().nullish() }),
    )
    .nullish(),
  preview: z.string().nullish(),
});

/**
 * Parse an Email/get listing response into summaries. The split mirrors
 * the wire-boundary rules: a structurally wrong ENVELOPE throws loudly
 * (that is Fastmail changing shape — the EXPENSE-S/X lesson), while a
 * single malformed ROW is skipped with a warning (one junk email must not
 * kill a whole mailbox listing; the next scan retries it).
 */
export function parseEmailSummaries(
  response: unknown,
  opts: { includePreview: boolean },
): ConnectionEmailSummary[] {
  const parsed = z
    .object({ list: z.array(z.unknown()).nullish() })
    .safeParse(response);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Email/get response shape mismatch: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? "invalid"}`,
    );
  }
  const summaries: ConnectionEmailSummary[] = [];
  for (const row of parsed.data.list ?? []) {
    const email = connectionEmailRowSchema.safeParse(row);
    if (!email.success) {
      console.warn(
        "[email-connections] skipping malformed Email/get row:",
        email.error.issues[0]?.path.join(".") || "(root)",
      );
      continue;
    }
    summaries.push({
      id: email.data.id,
      receivedAt: email.data.receivedAt ?? new Date().toISOString(),
      subject: email.data.subject ?? "",
      from: formatAddress(email.data.from?.[0]),
      ...(opts.includePreview ? { preview: email.data.preview ?? "" } : {}),
    });
  }
  return summaries;
}

/** Inbox summaries (role = "inbox"). Retained for the default adapter. */
export function inboxEmailSummaries(opts: {
  server: JmapServer;
  afterIso?: string;
  limit: number;
  descending?: boolean;
}): Promise<ConnectionEmailSummary[]> {
  return mailboxSummaries({ ...opts, role: "inbox" });
}

// --- Raw email ----------------------------------------------------------------
/** A connected mailbox's raw email. Aliases the shared RawRfc822Email
 * shape (jmap.server.ts); fetchRawRfc822 is the single builder for it. */
export type RawConnectionEmail = RawRfc822Email;

/** The full RFC 5322 source of an email (blob download), plus metadata. */
export async function rawConnectionEmail(
  server: JmapServer,
  id: string,
): Promise<RawConnectionEmail> {
  const s: JmapTokenInfo = await jmapSessionForToken(server);
  const email = await getEmailMetadata({
    server,
    accountId: s.mailAccountId,
    id,
  });
  return fetchRawRfc822({
    id,
    email,
    accountId: s.mailAccountId,
    downloadUrl: s.downloadUrl,
    headers: { Authorization: server.authorization },
  });
}

// --- Trash ---------------------------------------------------------------------

/**
 * Move an email to the Trash mailbox (recoverable; the connected-account
 * pipeline never destroys user mail) and mark it read. When the server has
 * no Trash role (RFC 8621 §2.5 allows that) the move is skipped and logged:
 * the expense still stands, so the mail is simply left in place.
 */
export async function moveConnectionEmailToTrash(
  server: JmapServer,
  id: string,
): Promise<void> {
  const trashId = await tryMailboxIdByRole(server, "trash");
  if (!trashId) {
    console.warn(
      `[email-connection] no trash role on ${serverLabel(server.sessionUrl)}; leaving ${id} in place`,
    );
    return;
  }
  await jmapCall(server, [
    [
      "Email/set",
      {
        accountId: (await jmapSessionForToken(server)).mailAccountId,
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
 * Email/import, with no EmailSubmission and no Identity/get. Fastmail API tokens
 * can read/write mail but cannot submit (urn:ietf:params:jmap:submission
 * is disallowed, HTTP 403), so a confirmation that goes to the mailbox
 * owner (self) is written as an Inbox message instead of being sent.
 * The owner sees it appear in their Inbox; the expense + Trash already
 * succeeded, so a delivery failure is logged and never fatal.
 */
export async function deliverConnectionEmailToInbox(
  server: JmapServer,
  input: SendEmailInput,
  fromAddress: string,
): Promise<boolean> {
  try {
    const inboxId = await mailboxIdByRole(server, "inbox");
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
    const s = await jmapSessionForToken(server);
    const blobId = await jmapUploadBlob(
      s.uploadUrl,
      s.mailAccountId,
      server.authorization,
      raw,
    );
    await jmapImportEmail(server, { blobId, mailboxId: inboxId });
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
