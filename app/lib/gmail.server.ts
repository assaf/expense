import { z } from "zod";
import { GOOGLE_PUBSUB_TOPIC } from "~/lib/env";
import {
  buildRfc822Message,
  type SendEmailInput,
} from "~/lib/email-mime.server";
import { formatAddress, type RawRfc822Email } from "~/lib/jmap.server";
import type {
  ConnectionEmailSummary,
  RawConnectionEmail,
} from "~/lib/email-connection-mail.server";
import { saveEmailConnectionWatch } from "~/lib/db/email-connections";
import type { OwnerEmail } from "~/lib/email-connection-process.server";

/**
 * Gmail API client for Gmail/Google Workspace connections: plain fetch
 * against gmail.googleapis.com, no SDK (repo style; also keeps the Vercel
 * tracer's static-import story intact). Only `gmail.modify` is used:
 * read/list, TRASH moves, `messages.import` for owner notifications
 * (import, never send: no gmail.send scope), and `users.watch` for push.
 *
 * Contracts mirrored from the JMAP adapter (email-connection-mail.server):
 * summaries are oldest-first for the drain unless `descending`, rawEmail
 * returns the shared RawRfc822Email shape, and moveToTrash marks read.
 */

const API_BASE = "https://gmail.googleapis.com";
const REQUEST_TIMEOUT_MS = 30_000;
// messages.list is always newest-first and its `after:` operator is
// day-granular, so enforcing the drain's exclusive-afterIso contract means
// scanning metadata past the boundary day. Hard cap so a hoarder inbox
// can't turn one drain batch into an unbounded scan.
const SCAN_CAP = 500;

async function gmailFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function gmailJson<T>(token: string, path: string): Promise<T> {
  const res = await gmailFetch(token, path);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Gmail API ${path} returned HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return JSON.parse(text) as T;
}

// --- Envelope helpers --------------------------------------------------------

const headerRowSchema = z.object({
  name: z.string(),
  value: z.string().nullish(),
});

const headerListSchema = z.array(headerRowSchema).nullish();

/** All values of one header name, in order (To can repeat: one row per
 * address); empty when the headers shape is unexpected. */
function headerValues(headers: unknown, name: string): string[] {
  const rows = headerListSchema.safeParse(headers);
  if (!rows.success) return [];
  const lower = name.toLowerCase();
  return (rows.data ?? [])
    .filter((row) => row.name.toLowerCase() === lower)
    .map((row) => row.value ?? "");
}

function headerValue(headers: unknown, name: string): string | null {
  return headerValues(headers, name)[0] ?? null;
}

/** internalDate is epoch-ms text; a missing/unparseable value falls back
 * to now (same tolerance as the JMAP adapter's nullish receivedAt). */
function receivedAtOf(meta: z.infer<typeof messageMetaSchema>): string {
  const ms = Number(meta.internalDate);
  return Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : new Date().toISOString();
}

// --- Inbox summaries ----------------------------------------------------------

interface MessageListItem {
  id?: unknown;
}

// The metadata fields summaries map from. internalDate is epoch-ms text.
const messageMetaSchema = z.object({
  id: z.string(),
  internalDate: z.string().nullish(),
  snippet: z.string().nullish(),
  payload: z.object({ headers: z.unknown().optional() }).nullish(),
});

function toSummary(
  meta: z.infer<typeof messageMetaSchema>,
  includePreview: boolean,
): ConnectionEmailSummary {
  return {
    id: meta.id,
    receivedAt: receivedAtOf(meta),
    subject: headerValue(meta.payload?.headers, "Subject") ?? "",
    from: headerValue(meta.payload?.headers, "From"),
    ...(includePreview ? { preview: meta.snippet ?? "" } : {}),
  };
}

async function listInboxMessageIds(
  token: string,
  query: string,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: query, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await gmailJson<{
      messages?: MessageListItem[];
      nextPageToken?: string;
    }>(token, `/gmail/v1/users/me/messages?${params.toString()}`);
    for (const m of page.messages ?? []) {
      if (typeof m.id === "string") ids.push(m.id);
    }
    pageToken =
      typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
    if (ids.length >= SCAN_CAP) break;
  } while (pageToken);
  return ids.slice(0, SCAN_CAP);
}

export async function gmailInboxSummaries(opts: {
  token: string;
  afterIso?: string;
  limit: number;
  descending?: boolean;
  includePreview?: boolean;
}): Promise<ConnectionEmailSummary[]> {
  // `after:` is day-granular (inclusive of the day), so the query over-
  // selects the boundary day and the precise exclusive filter below
  // trims it. Without afterIso the whole Inbox is the scan space.
  const day = opts.afterIso
    ? opts.afterIso.slice(0, 10).replaceAll("-", "/")
    : null;
  const query = day ? `in:inbox after:${day}` : "in:inbox";
  const ids = await listInboxMessageIds(opts.token, query);
  if (ids.length === 0) return [];

  // Metadata fetches in bounded parallel chunks; index order preserves
  // the list's newest-first order.
  const metaPath = (id: string) =>
    `/gmail/v1/users/me/messages/${id}?format=metadata`;
  const CHUNK = 20;
  const metas: z.infer<typeof messageMetaSchema>[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = await Promise.all(
      ids
        .slice(i, i + CHUNK)
        .map((id) => gmailJson<unknown>(opts.token, metaPath(id))),
    );
    metas.push(...chunk.map((m) => messageMetaSchema.parse(m)));
  }
  let summaries = metas.map((m) => toSummary(m, Boolean(opts.includePreview)));
  if (opts.afterIso) {
    const afterMs = Date.parse(opts.afterIso);
    summaries = summaries.filter((s) => Date.parse(s.receivedAt) > afterMs);
  }
  if (opts.descending) {
    // Review scan contract: newest-first, at most `limit`.
    return summaries.slice(0, opts.limit);
  }
  // Drain contract: oldest-first so the receivedAt cursor slides past the
  // newest email the batch returned.
  return summaries
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
    .slice(0, opts.limit);
}

// --- Raw email -----------------------------------------------------------------

async function gmailRawEmail(
  token: string,
  id: string,
): Promise<RawConnectionEmail> {
  const rawMsg = await gmailJson<{ raw?: unknown }>(
    token,
    `/gmail/v1/users/me/messages/${id}?format=raw`,
  );
  if (typeof rawMsg.raw !== "string") {
    throw new Error(`Gmail API raw message ${id} has no raw field`);
  }
  const meta = messageMetaSchema.parse(
    await gmailJson<unknown>(
      token,
      `/gmail/v1/users/me/messages/${id}?format=metadata`,
    ),
  );
  // To can repeat; metadata headers hold one row per address.
  const to = headerValues(meta.payload?.headers, "To")
    .map((value) => formatAddress({ name: null, email: value || null }))
    .filter((v): v is string => v !== null);
  return {
    id,
    raw: Buffer.from(rawMsg.raw, "base64url"),
    receivedAt: receivedAtOf(meta),
    subject: headerValue(meta.payload?.headers, "Subject") ?? "",
    from: headerValue(meta.payload?.headers, "From"),
    to,
    messageId: headerValue(meta.payload?.headers, "Message-ID") ?? "",
  } satisfies RawRfc822Email;
}

// --- Trash -----------------------------------------------------------------------

/** Move to Trash + mark read (gmail.modify permits the label change;
 * recoverable, the pipeline never destroys user mail). */
export async function gmailMoveToTrash(
  token: string,
  id: string,
): Promise<void> {
  const res = await gmailFetch(
    token,
    `/gmail/v1/users/me/messages/${id}/modify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX", "UNREAD"],
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Gmail API modify ${id} returned HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
}

// --- Owner notification (import, never send) ---------------------------------------

/**
 * Deliver a confirmation into the owner's own Inbox via
 * `messages.import` (needs only gmail.modify): the same bytes the JMAP
 * path builds, imported with neverMarkSpam so the owner sees it. Failure
 * is logged, never fatal (the expense is already saved).
 */
export async function gmailSendConnectionEmailToOwner(
  connection: { id: string; emailAddress: string },
  token: string,
  email: OwnerEmail,
): Promise<void> {
  const input: SendEmailInput = {
    to: connection.emailAddress,
    subject: email.subject,
    html: email.html,
    text: email.text,
    attachments: email.attachments,
  };
  const raw = buildRfc822Message({
    fromName: "",
    fromEmail: connection.emailAddress,
    ...input,
  });
  const meta = JSON.stringify({ labelIds: ["INBOX"] });
  const boundary = `expense-import-${Date.now()}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    meta,
    `--${boundary}`,
    "Content-Type: message/rfc822",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(raw).toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  try {
    const res = await gmailFetch(
      token,
      "/upload/gmail/v1/users/me/messages/import?internalDateSource=dateHeader&neverMarkSpam=true",
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/related; boundary="${boundary}"`,
        },
        body,
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Gmail messages.import returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    console.info("[email-connections] confirmation delivered to Inbox", {
      to: connection.emailAddress,
      subject: email.subject,
    });
  } catch (err) {
    console.error(
      `[email-connections] inbox delivery failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { to: connection.emailAddress, subject: email.subject },
    );
  }
}

// --- Push watch ---------------------------------------------------------------------

/**
 * (Re)start the Gmail push watch: new-INBOX-mail notifications go to the
 * Pub/Sub topic, which pushes to the webhook. Watches expire after ~7
 * days; the daily cron renews at a 48h margin. Google has no subscription
 * id, only an expiration, so pushSubscriptionId stays null.
 */
export async function ensureGmailWatch(
  connection: { id: string },
  accessToken: string,
): Promise<void> {
  const res = await gmailFetch(accessToken, "/gmail/v1/users/me/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topicName: GOOGLE_PUBSUB_TOPIC,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Gmail users.watch returned HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const body = JSON.parse(text) as {
    historyId?: unknown;
    expiration?: unknown;
  };
  if (
    typeof body.expiration !== "string" &&
    typeof body.expiration !== "number"
  ) {
    throw new Error("Gmail users.watch returned no expiration");
  }
  const expiresAt = new Date(Number(body.expiration)).toISOString();
  await saveEmailConnectionWatch(connection.id, expiresAt);
}

// --- Profile -------------------------------------------------------------------------

/** The Gmail-side address of the token's mailbox (connect-time
 * verification, the analog of verifyJmapToken). */
export async function gmailProfileEmail(accessToken: string): Promise<string> {
  const profile = await gmailJson<{ emailAddress?: unknown }>(
    accessToken,
    "/gmail/v1/users/me/profile",
  );
  if (typeof profile.emailAddress !== "string") {
    throw new Error("Gmail profile returned no emailAddress");
  }
  return profile.emailAddress;
}

// --- Adapter ---------------------------------------------------------------------------

/** The ConnectionMailAdapter over Gmail. Same interface as the JMAP
 * adapter (email-connection-process.server); the type import is
 * erased at runtime so this module never pulls the pipeline. */
export function gmailMailAdapter(
  token: string,
): import("~/lib/email-connection-process.server").ConnectionMailAdapter {
  return {
    inboxEmailSummaries: (opts) => gmailInboxSummaries({ token, ...opts }),
    rawEmail: (id) => gmailRawEmail(token, id),
    moveToTrash: (id) => gmailMoveToTrash(token, id),
  };
}
