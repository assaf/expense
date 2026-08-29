import {
  destroyEmail,
  isEmailNotFoundError,
  isEmailUpdateGoneError,
  markReceiptProcessed,
  markReceiptRetry,
  rawEmail,
  unprocessedReceiptIds,
  type RawEmail,
} from "~/lib/fastmail.server";
import {
  createMimeInboundCache,
  headerRecord,
  mimeFetchDeps,
} from "~/lib/mime-inbound.server";
import { captureError, captureWarning } from "~/lib/errors.server";
import { hasOwnConfirmationHeader } from "~/lib/email-classify";
import { processInboundEvent } from "~/lib/inbound-email.server";
import type {
  EmailReceivedData,
  InboundDeps,
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
 * world through the injectable `InboundDeps` collaborators; this module
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
  markRetry(id: string): Promise<void>;
  /** Permanently delete an email after a successful import. */
  destroyEmail(id: string): Promise<void>;
}

const realFastmailAdapter: FastmailAdapter = {
  rawEmail,
  unprocessedReceiptIds,
  markProcessed: markReceiptProcessed,
  markRetry: markReceiptRetry,
  destroyEmail,
};

// --- MIME parse cache --------------------------------------------------------
//
// fetchReceivedEmail + listAttachments + downloadAttachment are called
// repeatedly for the same email (and fetch+list run concurrently in the
// pipeline), so the raw download and MIME parse are memoized per email id
// in the shared mime-inbound module (TTL + LRU live there). Destroyed
// emails are invalidated immediately below.

const mimeCache = createMimeInboundCache();

/** Drop cached MIME for a destroyed email so its blob is never re-downloaded. */
function invalidateMimeCache(id: string): void {
  mimeCache.invalidate(id);
}

/** Clear the whole parse cache (test hook; also used after setup changes). */
export function clearMimeCache(): void {
  mimeCache.clear();
}

// --- InboundDeps over FastMail ----------------------------------------------

/** Build the `InboundDeps` collaborators that the pipeline needs from JMAP;
 * every other collaborator is the standard implementation. */
export function fastmailInboundDeps(adapter: FastmailAdapter): InboundDeps {
  return {
    ...mimeFetchDeps(mimeCache, adapter, {
      // The FastMail transport keys the cache by the raw JMAP id.
      cacheKey: (emailId) => emailId,
      foreignAttachmentSuffix: "not produced by FastMail",
    }),
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
 * `email_id` is the JMAP id: it becomes the `inbound_emails` idempotency
 * key, so re-fired pushes and the cron can never create duplicate expenses.
 */
export async function receiptEmailData(
  id: string,
  adapter: FastmailAdapter = realFastmailAdapter,
): Promise<EmailReceivedData> {
  const { raw, email } = await mimeCache.parsedEmail(id, id, adapter);
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
    headers: headerRecord(email.headers),
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
  /** Time budget before stopping mid-backlog (default 45s, headroom inside 60s). */
  timeBudgetMs?: number;
}

export interface ProcessUnprocessedResult {
  processed: number;
  failed: number;
  destroyed: number;
}

/** The outbound reply a processing result implies, for the per-email log. */
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
    case "concurrent":
      return "none (concurrent drain — another drain owns the reply)";
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
 */
export async function processUnprocessedReceipts(
  options: ProcessUnprocessedOptions = {},
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
  // generating reply after reply; suppress the duplicates and raise a
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
      try {
        const data = await receiptEmailData(id, adapter);
        // Loop guard: the app's own outbound mail carries the
        // X-Expense-Confirmation header. If one is filed back into the
        // Receipts folder, skip + destroy it: it's the app's own output,
        // not a user receipt. Header-based (stable), not subject-based.
        if (hasOwnConfirmationHeader(data.headers)) {
          console.info(
            "[fastmail-inbound] skipping own confirmation (loop guard)",
            {
              id,
              subject: data.subject,
            },
          );
          await adapter.destroyEmail(id);
          invalidateMimeCache(id);
          destroyed++;
          continue;
        }
        const result = await processInboundEvent(data, guardedDeps);
        if (result.status === "error") {
          // Handled failure: the error reply went to the sender, so a
          // re-drain would only re-send it. Mark permanently.
          await adapter.markProcessed(id);
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
        if (result.status === "concurrent") {
          // Another drain won the claim and is importing this email right
          // now. It sends the confirmation and destroys the email when
          // done. Destroying it here would yank it out from under the
          // winner mid-import (fetch fails, expense lost). Leave it alone.
          processed++;
          console.info("[fastmail-inbound] processed email", {
            id,
            subject: data.subject,
            from: data.from,
            status: result.status,
            reply: replyTypeFor(result),
          });
          continue;
        }
        // Mark only after success: a processing failure leaves the email
        // unmarked so the next drain retries it (bounded — see markRetry).
        await adapter.markProcessed(id);
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
        // one fetches it; rawEmail then reports "Email … not found". The
        // same race a step later hits markProcessed's Email/set update,
        // which reports notUpdated notFound instead (EXPENSE-T). Gone is
        // the desired end state either way, so skip silently instead of
        // Sentry noise. Everything else stays the marked-and-skipped path
        // below.
        if (isEmailNotFoundError(err) || isEmailUpdateGoneError(err)) {
          invalidateMimeCache(id);
          destroyed++;
          continue;
        }
        // No rollback: Fastmail won't remove the $receipt-processed keyword,
        // so an email that reaches this point stays marked and is skipped
        // next time. The email remains in the Receipts folder, so nothing is
        // lost. The error reply (when the pipeline got that far) or the
        // folder itself is the recovery path.
        failed++;
        captureError(err, { emailId: id });
        // One bounded retry: un-mark + flag, so the next drain re-runs
        // the pipeline (transient LLM/API failures self-heal). A second
        // failure flips it to permanently skipped (markReceiptRetry).
        await adapter.markRetry(id);
      }
    }

    if (ids.length < batchSize) break; // drained
    if (Date.now() - started > (options.timeBudgetMs ?? 45_000)) break;
  }

  return { processed, failed, destroyed };
}
