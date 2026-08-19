import PostalMime from "postal-mime";
import type { Email as ParsedEmail } from "postal-mime";
import {
  confirmationEmail,
  isDeliveryNotification,
  looksLikeBounce,
  extractReceiptFromSource,
  saveExpenseFromExtraction,
  selectReceiptSource,
  type AttachmentMeta,
  type InboundDeps,
  type ReceivedEmail,
} from "~/lib/inbound-email.server";
import { captureError } from "~/lib/errors.server";
import {
  classifyReceiptAttachment,
  extractReceipt,
} from "~/lib/receipt-ai.server";
import { extractFromImage } from "~/lib/receipt-ocr.server";
import { renderReceiptImage } from "~/lib/receipt-render.server";
import { renderEmailImage, renderTextEmail } from "~/lib/email-render.server";
import {
  inboxEmailSummaries,
  moveConnectionEmailToTrash,
  rawConnectionEmail,
  sendConnectionEmail,
  type ConnectionEmailSummary,
  type RawConnectionEmail,
} from "~/lib/email-connection-mail.server";
import { decryptSecret } from "~/lib/token-crypto.server";
import { matchEmailRule } from "~/lib/db/email-rules";
import prisma from "~/lib/prisma.server";
import { extractEmailAddress } from "~/lib/validation";
import type { EmailConnectionWithSecret } from "~/lib/db/email-connections";

/**
 * The connected-account processing pipeline: new mail in the user's Inbox →
 * rule match → receipt extraction → expense → Trash + a confirmation email
 * to the mailbox owner. Every decision lands in EmailProcessLog (the
 * health/audit log); errors leave the email in the Inbox untouched — the
 * user still sees it, so an expense is never silently lost.
 *
 * Differences from the receipts-by-email pipeline (processInboundEvent):
 *  - which emails to process is decided by RULES (general + user), not by
 *    verified sender addresses
 *  - unmatched / not-a-receipt / error emails are left in place and never
 *    answered (replying to merchants is wrong; notifying the user about
 *    every marketing email is noise)
 *  - success moves the email to Trash (recoverable — never destroy) and
 *    notifies the mailbox owner, from their own mailbox, with the edit link
 */

// --- Adapter (the mailbox operations; injectable for tests) -------------------

export interface ConnectionMailAdapter {
  /** Recent Inbox emails, oldest first. */
  inboxEmailSummaries(opts: {
    afterIso: string;
    limit: number;
  }): Promise<ConnectionEmailSummary[]>;
  /** Full RFC 5322 source of one email. */
  rawEmail(id: string): Promise<RawConnectionEmail>;
  /** Move an email to Trash + mark read. */
  moveToTrash(id: string): Promise<void>;
}

// --- MIME parse (per connection + email id) ------------------------------------

interface ParsedEntry {
  raw: RawConnectionEmail;
  email: ParsedEmail;
  fetchedAt: number;
}

const parseCache = new Map<string, Promise<ParsedEntry>>();
const PARSE_TTL_MS = 10 * 60_000;
const PARSE_CACHE_MAX = 20;

async function parsedEmail(
  key: string,
  adapter: ConnectionMailAdapter,
  emailId: string,
): Promise<ParsedEntry> {
  const existing = parseCache.get(key);
  if (existing) {
    const entry = await existing;
    if (Date.now() - entry.fetchedAt < PARSE_TTL_MS) return entry;
    parseCache.delete(key);
  }
  const promise = (async () => {
    const raw = await adapter.rawEmail(emailId);
    const email = await PostalMime.parse(raw.raw);
    return { raw, email, fetchedAt: Date.now() };
  })();
  if (parseCache.size >= PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  parseCache.set(key, promise);
  return promise;
}

// --- InboundDeps over the connection mailbox -----------------------------------

function headerRecord(headers: ParsedEmail["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.key] = h.value;
  return out;
}

function normalizeContentId(contentId: string | undefined): string | null {
  if (!contentId) return null;
  return contentId.replace(/^<|>$/g, "");
}

function toBytes(content: ArrayBuffer | Uint8Array | string): Buffer {
  return Buffer.from(content as ArrayBuffer);
}

function attachmentMeta(
  emailId: string,
  attachment: ParsedEmail["attachments"][number],
  index: number,
): AttachmentMeta {
  return {
    id: `${emailId}:${index}`,
    filename: attachment.filename ?? `attachment-${index + 1}`,
    size: toBytes(attachment.content).byteLength,
    content_type: attachment.mimeType,
    content_disposition: attachment.disposition,
    content_id: normalizeContentId(attachment.contentId),
    download_url: null,
    expires_at: null,
  };
}

/** The extraction/render collaborators the pipeline needs on top of the
 * adapter (tests inject fakes; the real ones come from receipt-ai/-ocr/
 * -render). downloadAttachment is NOT here — it is adapter-backed. */
export type ConnectionDeps = Pick<
  InboundDeps,
  | "classifyAttachment"
  | "extractReceipt"
  | "extractFromImage"
  | "renderReceiptImage"
  | "renderEmailImage"
  | "renderTextEmail"
>;

function realExtractionDeps(): ConnectionDeps {
  return {
    classifyAttachment: classifyReceiptAttachment,
    extractReceipt,
    extractFromImage,
    renderReceiptImage,
    renderEmailImage,
    renderTextEmail,
  };
}

/** Build the InboundDeps fetch collaborators over the connection mailbox. */
export function connectionInboundDeps(
  connectionId: string,
  adapter: ConnectionMailAdapter,
  extractionDeps: ConnectionDeps,
): InboundDeps {
  return {
    fetchReceivedEmail: async (emailId): Promise<ReceivedEmail> => {
      const { raw, email } = await parsedEmail(
        `${connectionId}:${emailId}`,
        adapter,
        emailId,
      );
      return {
        id: emailId,
        from: raw.from ?? "",
        to: raw.to,
        subject: email.subject ?? raw.subject,
        html: email.html ?? null,
        text: email.text ?? null,
        headers: headerRecord(email.headers),
        created_at: raw.receivedAt,
        message_id: email.messageId ?? raw.messageId,
      };
    },
    listAttachments: async (emailId): Promise<AttachmentMeta[]> => {
      const { email } = await parsedEmail(
        `${connectionId}:${emailId}`,
        adapter,
        emailId,
      );
      return email.attachments.map((a, index) =>
        attachmentMeta(emailId, a, index),
      );
    },
    downloadAttachment: async (meta): Promise<Buffer> => {
      const m = /^(.+):(\d+)$/.exec(meta.id ?? "");
      if (!m) {
        throw new Error(
          `Cannot resolve attachment "${meta.id}" — not produced by the connection adapter`,
        );
      }
      const { email } = await parsedEmail(
        `${connectionId}:${m[1]}`,
        adapter,
        m[1]!,
      );
      const attachment = email.attachments[Number(m[2])];
      if (!attachment) throw new Error(`Attachment ${meta.id} not found`);
      return toBytes(attachment.content);
    },
    ...extractionDeps,
    sendReply: async () => {
      // The connected pipeline never replies to senders; its notification
      // path is sendConnectionEmailToOwner, driven by the drain.
    },
  };
}

// --- Log + counters -------------------------------------------------------------

type LogOutcome = "ignored" | "created" | "partial" | "error";

async function logEmailDecision(input: {
  connectionId: string;
  emailId: string;
  fromAddress: string;
  subject: string;
  matched: boolean;
  outcome: LogOutcome;
  error?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await prisma.emailProcessLog.upsert({
    where: {
      connectionId_emailId: {
        connectionId: input.connectionId,
        emailId: input.emailId,
      },
    },
    update: {
      matched: input.matched,
      outcome: input.outcome,
      error: input.error ?? null,
    },
    create: {
      connectionId: input.connectionId,
      emailId: input.emailId,
      fromAddress: input.fromAddress,
      subject: input.subject.slice(0, 500),
      matched: input.matched,
      outcome: input.outcome,
      error: input.error ?? null,
      createdAt: now,
    },
  });
}

/** Has this connection already evaluated this email? */
async function seenEmail(
  connectionId: string,
  emailId: string,
): Promise<boolean> {
  const row = await prisma.emailProcessLog.findUnique({
    where: {
      connectionId_emailId: { connectionId, emailId },
    },
    select: { outcome: true },
  });
  return row !== null;
}

async function bumpReceived(connectionId: string): Promise<void> {
  await prisma.emailConnection.update({
    where: { id: connectionId },
    data: { receivedCount: { increment: 1 } },
  });
}

async function bumpProcessed(connectionId: string): Promise<void> {
  await prisma.emailConnection.update({
    where: { id: connectionId },
    data: { processedCount: { increment: 1 } },
  });
}

// --- Per-email processing ---------------------------------------------------------

export interface OwnerEmail {
  subject: string;
  html: string;
  text?: string;
  attachments?: { content: string; filename: string }[];
}

export type ConnectionEmailResult =
  | { status: "ignored"; reason: string }
  | { status: "created"; expenseId: string }
  | { status: "partial"; expenseId: string; missing: string[] }
  | { status: "error"; error: string };

/**
 * Evaluate one Inbox email for a connected account. Content problems are
 * logged and returned, never thrown — only the drain's adapter failures
 * propagate (they stop the batch).
 */
export async function processConnectionEmail(
  connection: EmailConnectionWithSecret,
  summary: ConnectionEmailSummary,
  deps: InboundDeps,
  adapters: {
    moveToTrash: (id: string) => Promise<void>;
    sendToOwner: (email: OwnerEmail) => Promise<void>;
  },
): Promise<ConnectionEmailResult> {
  const fromAddress = extractEmailAddress(summary.from ?? "");
  const log = (outcome: LogOutcome, matched: boolean, error?: string) =>
    logEmailDecision({
      connectionId: connection.id,
      emailId: summary.id,
      fromAddress,
      subject: summary.subject,
      matched,
      outcome,
      error,
    });

  // Our own notification emails (sent to self) must never be processed.
  if (fromAddress === connection.emailAddress) {
    await log("ignored", false, "self");
    return { status: "ignored", reason: "self" };
  }

  // Bounces/autoreplies: never import, never answer.
  if (looksLikeBounce({ subject: summary.subject, from: summary.from ?? "" })) {
    await log("ignored", false, "bounce");
    return { status: "ignored", reason: "bounce" };
  }

  // Rules decide what's even worth looking at.
  const rule = await matchEmailRule(connection.accountId, summary.from ?? "");
  if (!rule) {
    await log("ignored", false);
    return { status: "ignored", reason: "no rule" };
  }

  try {
    const email = await deps.fetchReceivedEmail(summary.id);
    if (isDeliveryNotification(email.headers)) {
      await log("ignored", true, "bounce");
      return { status: "ignored", reason: "bounce" };
    }

    const attachments = await deps.listAttachments(summary.id);
    const selected = await selectReceiptSource(email, attachments, deps);
    if (!selected.source) {
      // Rule matched but there's nothing usable — ignore, leave in Inbox.
      await log("ignored", true, "no receipt content");
      return { status: "ignored", reason: "no receipt content" };
    }

    const extracted = await extractReceiptFromSource({
      accountId: connection.accountId,
      email,
      attachments,
      source: selected.source,
      deps,
    });
    if (!extracted) {
      // Marketing mail from a rule-matched sender — ignore, leave in Inbox.
      await log("ignored", true, "not a receipt");
      return { status: "ignored", reason: "not a receipt" };
    }

    const saved = await saveExpenseFromExtraction({
      accountId: connection.accountId,
      expenseDate: selected.expenseDate,
      extraction: extracted.extraction,
      receiptImage: extracted.receiptImage,
      imageMime: extracted.imageMime,
      originalName: extracted.originalName,
    });

    // Success (complete or partial): move to Trash, notify the owner.
    // A Trash failure keeps the email in the Inbox — the log row prevents
    // a duplicate expense on the next drain, and the user still has the mail.
    await adapters.moveToTrash(summary.id);
    parseCache.delete(`${connection.id}:${summary.id}`);

    const confirmation = confirmationEmail({
      expenseId: saved.expenseId,
      date: selected.expenseDate,
      merchant: extracted.extraction.merchant,
      amount: extracted.extraction.amount,
      category: saved.category,
      report: saved.report,
      description: extracted.extraction.description,
      notes: [
        extracted.extraction.notes,
        extracted.extraction.currency && extracted.extraction.currency !== "USD"
          ? `Amount is in ${extracted.extraction.currency} — the app assumes USD.`
          : "",
        extracted.renderError
          ? `The email body could not be rendered as a receipt image (${extracted.renderError}). You can attach a photo in the app.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      intro:
        "This email was imported automatically as an expense. Here's what we found:",
      missing: saved.missing,
      reportStats: saved.reportStats,
    });
    await adapters.sendToOwner({
      subject: confirmation.subject,
      html: confirmation.html,
      attachments: saved.receiptAttachment
        ? [saved.receiptAttachment]
        : undefined,
    });

    await log(
      saved.missing.length > 0 ? "partial" : "created",
      true,
      saved.missing.length > 0
        ? `Missing: ${saved.missing.join(", ")}`
        : undefined,
    );
    if (saved.missing.length > 0) {
      return {
        status: "partial",
        expenseId: saved.expenseId,
        missing: saved.missing,
      };
    }
    return { status: "created", expenseId: saved.expenseId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[email-connections] processing failed:", {
      connectionId: connection.id,
      emailId: summary.id,
      err,
    });
    await log("error", true, message);
    return { status: "error", error: message };
  }
}

// --- Drain -----------------------------------------------------------------------

export interface DrainOptions {
  /** Mailbox operations; defaults to the real JMAP adapter (user token). */
  adapter?: ConnectionMailAdapter;
  extractionDeps?: ConnectionDeps;
  /** Lookback window for the Inbox query (default 3 days — pushes are
   * near-real-time; this is the missed-push catch-up). */
  lookbackMs?: number;
  /** Max emails per query batch (default 10). */
  batchSize?: number;
  /** Time budget before stopping mid-backlog (default 45s — headroom in 60s). */
  timeBudgetMs?: number;
}

export interface DrainResult {
  evaluated: number;
  created: number;
  partial: number;
  ignored: number;
  failed: number;
}

/**
 * Drain new Inbox mail for one connection: evaluate each unseen email,
 * create expenses for receipts, Trash + notify on success. Bounded by batch
 * size and a time budget; the daily cron re-runs it as the catch-up net.
 * Counters: receivedCount bumps per newly-evaluated email, processedCount
 * per created/partial.
 */
export async function drainEmailConnection(
  connection: EmailConnectionWithSecret,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const token = decryptSecret(connection.tokenEnc);
  const adapter: ConnectionMailAdapter = options.adapter ?? {
    inboxEmailSummaries: (opts) => inboxEmailSummaries({ token, ...opts }),
    rawEmail: (id) => rawConnectionEmail(token, id),
    moveToTrash: (id) => moveConnectionEmailToTrash(token, id),
  };
  const extractionDeps = options.extractionDeps ?? realExtractionDeps();
  const deps = connectionInboundDeps(connection.id, adapter, extractionDeps);

  const lookbackMs = options.lookbackMs ?? 3 * 24 * 60 * 60 * 1000;
  const batchSize = options.batchSize ?? 10;
  const started = Date.now();

  const result: DrainResult = {
    evaluated: 0,
    created: 0,
    partial: 0,
    ignored: 0,
    failed: 0,
  };

  const adapters = {
    moveToTrash: (id: string) => adapter.moveToTrash(id),
    sendToOwner: (email: OwnerEmail) =>
      sendConnectionEmailToOwner(connection, token, email),
  };

  while (true) {
    const afterIso = new Date(Date.now() - lookbackMs).toISOString();
    const summaries = await adapter.inboxEmailSummaries({
      afterIso,
      limit: batchSize,
    });
    // Skip already-evaluated emails (push + cron race, re-delivered mail).
    const fresh: ConnectionEmailSummary[] = [];
    for (const summary of summaries) {
      if (!(await seenEmail(connection.id, summary.id))) fresh.push(summary);
    }
    if (fresh.length === 0) break;

    for (const summary of fresh) {
      if (Date.now() - started > (options.timeBudgetMs ?? 45_000)) {
        console.warn("[email-connections] drain time budget reached", {
          connectionId: connection.id,
        });
        return result;
      }
      result.evaluated++;
      await bumpReceived(connection.id);
      const outcome = await processConnectionEmail(
        connection,
        summary,
        deps,
        adapters,
      );
      switch (outcome.status) {
        case "created":
          result.created++;
          await bumpProcessed(connection.id);
          break;
        case "partial":
          result.partial++;
          await bumpProcessed(connection.id);
          break;
        case "error":
          result.failed++;
          break;
        case "ignored":
          result.ignored++;
          break;
      }
      console.info("[email-connections] evaluated email", {
        connectionId: connection.id,
        emailId: summary.id,
        subject: summary.subject,
        from: summary.from,
        outcome: outcome.status,
      });
    }
  }
  return result;
}

/** Send the confirmation email to the mailbox owner, from their mailbox. */
async function sendConnectionEmailToOwner(
  connection: EmailConnectionWithSecret,
  token: string,
  email: OwnerEmail,
): Promise<void> {
  const ok = await sendConnectionEmail(
    token,
    {
      to: connection.emailAddress,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: email.attachments,
    },
    connection.emailAddress,
  );
  if (!ok) {
    captureError(
      "[email-connections] confirmation email failed (expense is saved)",
      { connectionId: connection.id, to: connection.emailAddress },
    );
  }
}
