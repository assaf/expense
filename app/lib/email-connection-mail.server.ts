import {
  jmapCall,
  jmapSessionForToken,
  type JmapTokenInfo,
} from "~/lib/jmap.server";
import {
  buildRfc822Message,
  type SendEmailInput,
} from "~/lib/email-mime.server";
import { captureWarning } from "~/lib/errors.server";

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

const REQUEST_TIMEOUT_MS = 30_000;

// --- Mailboxes ---------------------------------------------------------------

interface MailboxList {
  list: Array<{ id: string; name?: string; role?: string }>;
}

async function mailboxIdByRole(token: string, role: string): Promise<string> {
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
}

/**
 * Recent emails in the account's Inbox, oldest first. The drain passes an
 * `afterIso` lookback window; already-evaluated emails are skipped by the
 * caller via the EmailProcessLog (idempotency), not by the query.
 */
export async function inboxEmailSummaries(opts: {
  token: string;
  afterIso: string;
  limit: number;
}): Promise<ConnectionEmailSummary[]> {
  const inboxId = await mailboxIdByRole(opts.token, "inbox");
  const query = await jmapCall(opts.token, [
    [
      "Email/query",
      {
        accountId: (await jmapSessionForToken(opts.token)).mailAccountId,
        filter: { inMailbox: inboxId, after: opts.afterIso },
        sort: [{ property: "receivedAt", isAscending: true }],
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
        properties: ["id", "receivedAt", "subject", "from"],
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
    };
    const first = email.from?.[0];
    return {
      id: email.id,
      receivedAt: email.receivedAt ?? new Date().toISOString(),
      subject: email.subject ?? "",
      from: first?.email
        ? first.name
          ? `${first.name} <${first.email}>`
          : first.email
        : null,
    };
  });
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

function formatAddress(a?: { name?: string; email?: string }): string | null {
  if (!a?.email) return null;
  return a.name ? `${a.name} <${a.email}>` : a.email;
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
  const email = list[0] as
    | {
        blobId?: string;
        receivedAt?: string;
        subject?: string;
        from?: Array<{ name?: string; email?: string }>;
        to?: Array<{ name?: string; email?: string }>;
        messageId?: string;
      }
    | undefined;
  if (!email) throw new Error(`Email ${id} not found`);

  const url = s.downloadUrl
    .replace("{accountId}", s.mailAccountId)
    .replace("{blobId}", email.blobId ?? "")
    .replace("{name}", "email.eml")
    .replace("{type}", "message/rfc822");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
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

// --- Trash ---------------------------------------------------------------------

/**
 * Move an email to the Trash mailbox (recoverable — the connected-account
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

// --- Sending (as the user) ------------------------------------------------------

interface ConnectionIdentity {
  id: string;
  name: string;
  email: string;
  saveSentToMailboxId: string;
}

/** The user's sending identities (Identity/get). */
async function listConnectionIdentities(
  token: string,
): Promise<ConnectionIdentity[]> {
  const responses = await jmapCall(
    token,
    [
      [
        "Identity/get",
        { accountId: (await jmapSessionForToken(token)).mailAccountId },
        "m0",
      ],
    ],
    ["urn:ietf:params:jmap:submission"],
  );
  const list = (responses[0]![1] as { list?: unknown[] }).list ?? [];
  return list
    .map((i) => {
      const identity = i as {
        id: string;
        name?: string;
        email?: string;
        saveSentToMailboxId?: string;
      };
      return {
        id: identity.id,
        name: identity.name ?? "",
        email: identity.email ?? "",
        saveSentToMailboxId: identity.saveSentToMailboxId ?? "",
      };
    })
    .filter((i) => i.email);
}

function matchIdentity(
  identities: ConnectionIdentity[],
  address: string,
): ConnectionIdentity | undefined {
  const lower = address.toLowerCase();
  return identities.find((i) => i.email.toLowerCase() === lower);
}

/** The JMAP send flow's collaborators — injectable so tests exercise the
 * identity→upload→import→submit sequence offline. */
export interface ConnectionSendDeps {
  listIdentities(token: string): Promise<ConnectionIdentity[]>;
  uploadBlob(token: string, raw: Buffer): Promise<string>;
  importEmail(
    token: string,
    blobId: string,
    mailboxId: string,
  ): Promise<string>;
  submitEmail(
    token: string,
    identityId: string,
    emailId: string,
  ): Promise<void>;
}

async function uploadBlob(token: string, raw: Buffer): Promise<string> {
  const s = await jmapSessionForToken(token);
  const url = s.uploadUrl.replace("{accountId}", s.mailAccountId);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
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

async function importEmail(
  token: string,
  blobId: string,
  mailboxId: string,
): Promise<string> {
  const responses = await jmapCall(token, [
    [
      "Email/import",
      {
        accountId: (await jmapSessionForToken(token)).mailAccountId,
        emails: {
          e1: { blobId, mailboxIds: mailboxId ? { [mailboxId]: true } : {} },
        },
      },
      "m0",
    ],
  ]);
  const created = (
    responses[0]![1] as {
      created?: Record<string, { id: string } | null>;
    }
  ).created?.["e1"];
  if (!created) throw new Error("Email/import did not create the message");
  return created.id;
}

async function submitEmail(
  token: string,
  identityId: string,
  emailId: string,
): Promise<void> {
  await jmapCall(
    token,
    [
      [
        "EmailSubmission/set",
        {
          accountId: (await jmapSessionForToken(token)).mailAccountId,
          create: { k1: { identityId, emailId } },
        },
        "m0",
      ],
    ],
    ["urn:ietf:params:jmap:submission"],
  );
}

const realConnectionSendDeps: ConnectionSendDeps = {
  listIdentities: listConnectionIdentities,
  uploadBlob,
  importEmail,
  submitEmail,
};

/**
 * Send an email from the user's own mailbox (their identity, matched to
 * `fromAddress`). Same sequence as the app's own FastMail send — upload
 * the raw MIME blob, import it into the identity's Sent mailbox, submit —
 * with the same one-retry-on-transient-submission-failure policy: a lost
 * confirmation makes the user think the receipt wasn't captured. Never
 * throws; returns false on failure (already logged + captured).
 */
export async function sendConnectionEmail(
  token: string,
  input: SendEmailInput,
  fromAddress: string,
  deps: ConnectionSendDeps = realConnectionSendDeps,
): Promise<boolean> {
  try {
    const identities = await deps.listIdentities(token);
    const identity = matchIdentity(identities, fromAddress) ?? identities[0];
    if (!identity) {
      console.warn("[email-connections] send skipped: no identity found");
      return false;
    }
    const raw = buildRfc822Message({
      fromName: identity.name,
      fromEmail: identity.email,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      inReplyTo: input.inReplyTo,
      attachments: input.attachments,
    });
    const blobId = await deps.uploadBlob(token, raw);
    const emailId = await deps.importEmail(
      token,
      blobId,
      identity.saveSentToMailboxId,
    );
    try {
      await deps.submitEmail(token, identity.id, emailId);
    } catch (err) {
      // Transient submission failure — retry once with the SAME emailId
      // (the upload + Sent import already succeeded). See the rationale in
      // fastmail.server.ts sendEmailViaJmap.
      console.warn(
        `[email-connections] submit failed, retrying once: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { to: input.to, subject: input.subject },
      );
      await deps.submitEmail(token, identity.id, emailId);
    }
    return true;
  } catch (err) {
    captureWarning(
      `[email-connections] send failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { to: input.to, subject: input.subject },
    );
    return false;
  }
}
