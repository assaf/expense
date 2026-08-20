import PostalMime from "postal-mime";
import type { Email as ParsedEmail } from "postal-mime";
import {
  destroyEmail,
  isEmailNotFoundError,
  markReceiptProcessed,
  rawEmail,
  unprocessedReceiptIds,
  type RawEmail,
} from "~/lib/fastmail.server";
import { captureError, captureWarning } from "~/lib/errors.server";
import { processInboundEvent } from "~/lib/inbound-email.server";
import type {
  AttachmentMeta,
  EmailReceivedData,
  InboundDeps,
  ReceivedEmail,
} from "~/lib/inbound-email.server";
import {
  classifyReceiptAttachment,
  extractReceipt,
} from "~/lib/receipt-ai.server";
import { extractFromImage } from "~/lib/receipt-ocr.server";
import { extractEmailAddress } from "~/lib/validation";
import { renderReceiptImage } from "~/lib/receipt-render.server";
import { renderEmailImage, renderTextEmail } from "~/lib/email-render.server";
import { sendEmail } from "~/lib/reply.server";

/**
 * FastMail-backed transport for the receipts-by-email pipeline.
 *
 * The pipeline (`processInboundEvent` in inbound-email.server) talks to the
 * world through the injectable `InboundDeps` collaborators — this module
 * implements the three fetch collaborators (email, attachment list, blob
 * download) over FastMail JMAP instead of the Resend API, so the whole
 * OCR/DeepSeek/expense-create pipeline runs unchanged.
 *
 * Flow: a Fastmail delivery rule files receipts into a folder (never the
 * Inbox); a JMAP StateChange push (or the daily cron) triggers
 * `processUnprocessedReceipts`, which marks each email `$receipt-processed`,
 * runs the pipeline, and destroys the email after a successful import.
 * Emails that fail stay in the folder (marked) as the safety net; the
 * pipeline's reply email is the recovery path.
 */

// --- JMAP adapter (injectable for tests) ------------------------------------

export interface FastmailAdapter {
  /** Email/get + full RFC 5322 blob download for one email. */
  rawEmail(id: string): Promise<RawEmail>;
  /** Unprocessed receipt email ids in the Receipts folder, oldest first. */
  unprocessedReceiptIds(limit: number): Promise<string[]>;
  /** Set the `$receipt-processed` keyword (mark-before-process). */
  markProcessed(id: string): Promise<void>;
  /** Permanently delete an email after a successful import. */
  destroyEmail(id: string): Promise<void>;
}

const realFastmailAdapter: FastmailAdapter = {
  rawEmail,
  unprocessedReceiptIds,
  markProcessed: markReceiptProcessed,
  destroyEmail,
};

// --- MIME parse cache --------------------------------------------------------
//
// fetchReceivedEmail + listAttachments + downloadAttachment are called
// repeatedly for the same email (and fetch+list run concurrently in the
// pipeline), so the raw download and MIME parse are memoized per email id.
// Entries expire after PARSE_TTL_MS and the cache is size-capped; destroyed
// emails are invalidated immediately.

interface ParsedEntry {
  raw: RawEmail;
  email: ParsedEmail;
  fetchedAt: number;
}

const parseCache = new Map<string, Promise<ParsedEntry>>();
const PARSE_TTL_MS = 10 * 60_000;
const PARSE_CACHE_MAX = 20;

function toBytes(content: ArrayBuffer | Uint8Array | string): Buffer {
  return Buffer.from(content as ArrayBuffer);
}

async function parsedEmail(
  id: string,
  adapter: FastmailAdapter,
): Promise<ParsedEntry> {
  const existing = parseCache.get(id);
  if (existing) {
    const entry = await existing;
    if (Date.now() - entry.fetchedAt < PARSE_TTL_MS) return entry;
    parseCache.delete(id);
  }
  const promise = (async () => {
    const raw = await adapter.rawEmail(id);
    const email = await PostalMime.parse(raw.raw);
    return { raw, email, fetchedAt: Date.now() };
  })();
  if (parseCache.size >= PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  parseCache.set(id, promise);
  return promise;
}

/** Drop cached MIME for a destroyed email so its blob is never re-downloaded. */
function invalidateMimeCache(id: string): void {
  parseCache.delete(id);
}

/** Clear the whole parse cache (test hook; also used after setup changes). */
export function clearMimeCache(): void {
  parseCache.clear();
}

// --- InboundDeps over FastMail ----------------------------------------------

function headerRecord(headers: ParsedEmail["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.key] = h.value;
  return out;
}

/** Fastmail `contentId` may carry angle brackets; HTML references use `cid:` without them. */
function normalizeContentId(contentId: string | undefined): string | null {
  if (!contentId) return null;
  return contentId.replace(/^<|>$/g, "");
}

/** Attachment metadata for one MIME part; `id` encodes `emailId:index` so
 * downloadAttachment can resolve the blob without a second JMAP call. */
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

/** Build the `InboundDeps` collaborators that the pipeline needs from JMAP;
 * every other collaborator is the standard implementation. */
export function fastmailInboundDeps(adapter: FastmailAdapter): InboundDeps {
  return {
    fetchReceivedEmail: async (emailId): Promise<ReceivedEmail> => {
      const { raw, email } = await parsedEmail(emailId, adapter);
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
      const { email } = await parsedEmail(emailId, adapter);
      return email.attachments.map((a, index) =>
        attachmentMeta(emailId, a, index),
      );
    },
    downloadAttachment: async (meta): Promise<Buffer> => {
      const m = /^(.+):(\d+)$/.exec(meta.id ?? "");
      if (!m) {
        throw new Error(
          `Cannot resolve attachment "${meta.id}" — not produced by FastMail`,
        );
      }
      const { email } = await parsedEmail(m[1]!, adapter);
      const attachment = email.attachments[Number(m[2]!)];
      if (!attachment) throw new Error(`Attachment ${meta.id} not found`);
      return toBytes(attachment.content);
    },
    classifyAttachment: classifyReceiptAttachment,
    extractReceipt,
    extractFromImage,
    renderReceiptImage,
    renderEmailImage,
    renderTextEmail,
    sendReply: async (input) => {
      await sendEmail(input);
    },
  };
}

// --- Webhook/cron entry point -----------------------------------------------

/**
 * Build the webhook-shaped `EmailReceivedData` for a Fastmail email. The
 * `email_id` is the JMAP id — it becomes the `inbound_emails` idempotency
 * key, so re-fired pushes and the cron can never create duplicate expenses.
 */
export async function receiptEmailData(
  id: string,
  adapter: FastmailAdapter = realFastmailAdapter,
): Promise<EmailReceivedData> {
  const { raw } = await parsedEmail(id, adapter);
  return {
    email_id: id,
    created_at: raw.receivedAt,
    from: raw.from ?? "",
    to: raw.to,
    bcc: [],
    cc: [],
    received_for: [],
    message_id: raw.messageId,
    subject: raw.subject,
    // The pipeline never reads data.attachments (metadata comes from
    // deps.listAttachments), so this stays empty.
    attachments: [],
  };
}

export interface ProcessUnprocessedOptions {
  adapter?: FastmailAdapter;
  deps?: InboundDeps;
  /** Max emails per query batch (default 10). */
  batchSize?: number;
  /** Time budget before stopping mid-backlog (default 45s — headroom inside 60s). */
  timeBudgetMs?: number;
}

export interface ProcessUnprocessedResult {
  processed: number;
  failed: number;
  destroyed: number;
}

/** The outbound reply a processing result implies — for the per-email log. */
function replyTypeFor(
  result: Awaited<ReturnType<typeof processInboundEvent>>,
): string {
  switch (result.status) {
    case "created":
      return "confirmation (accepted)";
    case "partial":
      return `confirmation (partial — missing ${result.missing.join(", ")})`;
    case "error":
      return "failure";
    case "unknown-sender":
      return "sender not recognized";
    case "unverified-sender":
      return "verify first";
    case "duplicate":
      return "none (duplicate)";
    case "self-reply":
      return "none (self-reply)";
    case "bounce":
      return "none (bounce)";
  }
}

/**
 * Process unprocessed emails in the Receipts folder. Each email is marked
 * `$receipt-processed` BEFORE processing (a concurrent push or cron must see
 * it as handled, or it would be processed twice), then the pipeline runs and
 * the email is destroyed on any non-error result. Error results stay in the
 * folder, marked, and are skipped on the next run.
 *
 * With no time budget pressure, drains the whole backlog: re-queries after
 * each batch (marked emails drop out) until empty, bounded by timeBudgetMs.
 *
 * Single-flight: concurrent calls (a burst of pushes, or the cron overlapping
 * a push) serialize on this instance — the second caller joins the first
 * drain instead of racing it, so the same email can never be listed by two
 * drains at once. The lock is per-instance (Vercel may run several lambdas);
 * cross-instance overlap is still possible and is handled silently by the
 * notFound guards in rawEmail/destroyEmail.
 */
let drainInFlight: Promise<ProcessUnprocessedResult> | null = null;

export function processUnprocessedReceipts(
  options: ProcessUnprocessedOptions = {},
): Promise<ProcessUnprocessedResult> {
  if (!drainInFlight) {
    drainInFlight = runDrain(options).finally(() => {
      drainInFlight = null;
    });
  }
  return drainInFlight;
}

async function runDrain(
  options: ProcessUnprocessedOptions,
): Promise<ProcessUnprocessedResult> {
  const adapter = options.adapter ?? realFastmailAdapter;
  const deps = options.deps ?? fastmailInboundDeps(adapter);
  const batchSize = options.batchSize ?? 10;
  const started = Date.now();
  let processed = 0;
  let failed = 0;
  let destroyed = 0;

  // Reply circuit breaker: never reply to the same address twice in one
  // drain. A drain legitimately replies to each sender at most once, so a
  // repeated target means the same mail (typically a bounce or an
  // autoresponder that slipped past the guards in inbound-email.server) is
  // generating reply after reply — suppress the duplicates and raise a
  // Sentry warning instead of filling the Sent folder. Bounded to this
  // drain (no persistence): the durable stop is the bounce guard; this is
  // the alarm that fires when the guard is bypassed.
  const repliedTo = new Set<string>();
  const guardedDeps: InboundDeps = {
    ...deps,
    sendReply: async (input) => {
      const target = extractEmailAddress(input.to);
      if (repliedTo.has(target)) {
        captureWarning(
          "[inbound] duplicate reply suppressed — possible bounce loop",
          { to: input.to, subject: input.subject },
        );
        return;
      }
      repliedTo.add(target);
      await deps.sendReply(input);
    },
  };

  while (true) {
    const ids = await adapter.unprocessedReceiptIds(batchSize);
    if (ids.length === 0) break;

    for (const id of ids) {
      await adapter.markProcessed(id);
      try {
        const data = await receiptEmailData(id, adapter);
        const result = await processInboundEvent(data, guardedDeps);
        if (result.status === "error") {
          failed++;
          console.info("[fastmail-inbound] processed email", {
            id,
            subject: data.subject,
            from: data.from,
            status: result.status,
            reply: replyTypeFor(result),
          });
          continue;
        }
        await adapter.destroyEmail(id);
        invalidateMimeCache(id);
        destroyed++;
        processed++;
        console.info("[fastmail-inbound] processed email", {
          id,
          subject: data.subject,
          from: data.from,
          status: result.status,
          reply: replyTypeFor(result),
          destroyed: true,
          ...(result.status === "bounce" && result.failedRecipient
            ? { failedRecipient: result.failedRecipient }
            : {}),
        });
      } catch (err) {
        // A concurrent drain (a burst of pushes, or the cron overlapping a
        // push) can list an email that another drain destroys before this
        // one fetches it — rawEmail then reports "Email … not found". Gone
        // is the desired end state, so skip silently instead of Sentry
        // noise (EXPENSE-K). Everything else stays the marked-and-skipped
        // path below.
        if (isEmailNotFoundError(err)) {
          invalidateMimeCache(id);
          destroyed++;
          continue;
        }
        // No rollback: Fastmail won't remove the $receipt-processed keyword,
        // so an email that reaches this point stays marked and is skipped
        // next time. The email remains in the Receipts folder, so nothing is
        // lost — the error reply (when the pipeline got that far) or the
        // folder itself is the recovery path.
        failed++;
        captureError(err, { emailId: id });
      }
    }

    if (ids.length < batchSize) break; // drained
    if (Date.now() - started > (options.timeBudgetMs ?? 45_000)) break;
  }

  return { processed, failed, destroyed };
}
