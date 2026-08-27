import {
  isDeliveryNotification,
  looksLikeBounce,
  extractReceiptFromSource,
  saveExpenseFromExtraction,
  selectReceiptSource,
  type InboundDeps,
} from "~/lib/inbound-email.server";
import {
  confirmationEmail,
  confirmationNotes,
} from "~/lib/email-confirmation.server";
import {
  createMimeInboundCache,
  mimeFetchDeps,
} from "~/lib/mime-inbound.server";
import { captureError, captureWarning } from "~/lib/errors.server";
import { extractReceipt } from "~/lib/receipt-ai.server";
// Heavy render/OCR modules (resvg font chain, tesseract wasm, headless
// chromium) are lazy-loaded inside realExtractionDeps so importing this
// module never pulls them; scripts/tests that inject stub deps stay light.
import {
  inboxEmailSummaries,
  moveConnectionEmailToTrash,
  rawConnectionEmail,
  deliverConnectionEmailToInbox,
  type ConnectionEmailSummary,
  type RawConnectionEmail,
} from "~/lib/email-connection-mail.server";
import { decryptSecret } from "~/lib/token-crypto.server";
import { matchEmailRule } from "~/lib/db/email-rules";
import { findRecentlyImportedMatch } from "~/lib/db/expenses";
import {
  classifyReceiptEmail,
  hasOwnConfirmationHeader,
} from "~/lib/email-classify";
import { htmlToText } from "~/lib/html-text";
import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { isUniqueViolation } from "~/lib/db/pg-errors";
import { fromIso } from "~/lib/db/wire";
import { extractEmailAddress } from "~/lib/validation";
import type { EmailConnectionWithSecret } from "~/lib/db/email-connections";

/**
 * The connected-account processing pipeline: new mail in the user's Inbox →
 * rule match → receipt extraction → expense → Trash + a confirmation email
 * to the mailbox owner. Every decision lands in EmailProcessLog (the
 * health/audit log); errors leave the email in the Inbox untouched: the
 * user still sees it, so an expense is never silently lost.
 *
 * Differences from the receipts-by-email pipeline (processInboundEvent):
 *  - which emails to process is decided by RULES (general + user), not by
 *    verified sender addresses
 *  - unmatched / not-a-receipt / error emails are left in place and never
 *    answered (replying to merchants is wrong; notifying the user about
 *    every marketing email is noise)
 *  - success moves the email to Trash (recoverable, never destroyed) and
 *    notifies the mailbox owner, from their own mailbox, with the edit link
 */

// --- Adapter (the mailbox operations; injectable for tests) -------------------

export interface ConnectionMailAdapter {
  /** Recent Inbox emails: the drain's lookback query (oldest first) or
   * the review scan's newest-first batch (pass `descending`). */
  inboxEmailSummaries(opts: {
    afterIso?: string;
    limit: number;
    descending?: boolean;
  }): Promise<ConnectionEmailSummary[]>;
  /** Full RFC 5322 source of one email. */
  rawEmail(id: string): Promise<RawConnectionEmail>;
  /** Move an email to Trash + mark read. */
  moveToTrash(id: string): Promise<void>;
}

// --- MIME parse (per connection + email id) ------------------------------------
//
// fetchReceivedEmail + listAttachments + downloadAttachment are memoized per
// `${connectionId}:${emailId}` in the shared mime-inbound module (TTL + LRU
// live there). The cache is dropped per email after it moves to Trash.

const mimeCache = createMimeInboundCache();

// --- InboundDeps over the connection mailbox -----------------------------------

/** The extraction/render collaborators the pipeline needs on top of the
 * adapter (tests inject fakes; the real ones come from receipt-ai/-ocr/
 * -render). downloadAttachment is NOT here; it is adapter-backed. */
export type ConnectionDeps = Pick<
  InboundDeps,
  | "classifyAttachment"
  | "extractReceipt"
  | "extractFromImage"
  | "renderReceiptImage"
  | "renderEmailImage"
  | "renderTextEmail"
>;

export function realExtractionDeps(): ConnectionDeps {
  return {
    // The connected flow is LLM-free: ambiguous-attachment selection
    // never calls the model tiebreak (returns null -> falls through to
    // the email body, which extracts locally). Attachment receipts that
    // can't be read locally are skipped for manual review.
    classifyAttachment: async () => null,
    extractReceipt,
    extractFromImage: (input) =>
      import("~/lib/receipt-ocr.server").then((m) => m.extractFromImage(input)),
    renderReceiptImage: (text, opts) =>
      import("~/lib/receipt-render.server").then((m) =>
        m.renderReceiptImage(text, opts),
      ),
    renderEmailImage: (html, opts) =>
      import("~/lib/email-render.server").then((m) =>
        m.renderEmailImage(html, opts),
      ),
    renderTextEmail: (text, opts) =>
      import("~/lib/email-render.server").then((m) =>
        m.renderTextEmail(text, opts),
      ),
  };
}

/** Build the InboundDeps fetch collaborators over the connection mailbox. */
export function connectionInboundDeps(
  connectionId: string,
  adapter: ConnectionMailAdapter,
  extractionDeps: ConnectionDeps,
): InboundDeps {
  return {
    ...mimeFetchDeps(mimeCache, adapter, {
      // Cache keys are namespaced per connection so one shared cache serves
      // every connected account in the process.
      cacheKey: (emailId) => `${connectionId}:${emailId}`,
      foreignAttachmentSuffix: "not produced by the connection adapter",
    }),
    ...extractionDeps,
    sendReply: async () => {
      // The connected pipeline never replies to senders; its notification
      // path is sendConnectionEmailToOwner, driven by the drain.
    },
  };
}

// --- Log + counters -------------------------------------------------------------

type LogOutcome =
  | "ignored"
  | "created"
  | "partial"
  | "error"
  | "processing"
  | "pending-review"
  | "review-ignored";

async function logEmailDecision(input: {
  connectionId: string;
  emailId: string;
  fromAddress: string;
  subject: string;
  matched: boolean;
  outcome: LogOutcome;
  /** Why the row landed on its outcome (ignored reasons, partial's
   * "Missing: ..." list). Distinct from `error`, which holds failure
   * text for outcome "error" / retryable pending rows. */
  reason?: string;
  /** The expense this decision is about (see the column comment). */
  expenseId?: string;
  /** Failure text; the UI surfaces it on pending items. */
  error?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  // The (connectionId, emailId) uniqueness is a unique index, not a
  // constraint Prisma 8's upsert conflictOn can target, so update the
  // claimed row in place; the defensive create covers a row that vanished.
  const updated = await db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(input.connectionId), l.emailId.eq(input.emailId)),
  ).updateAll({
    matched: input.matched,
    outcome: input.outcome,
    reason: input.reason ?? null,
    expenseId: input.expenseId ?? null,
    error: input.error ?? null,
  });
  if (updated.length === 0) {
    await db.orm.public.EmailProcessLog.create({
      connectionId: input.connectionId,
      emailId: input.emailId,
      fromAddress: input.fromAddress,
      subject: input.subject.slice(0, 500),
      matched: input.matched,
      outcome: input.outcome,
      reason: input.reason ?? null,
      expenseId: input.expenseId ?? null,
      error: input.error ?? null,
      createdAt: fromIso(now),
    });
  }
}

/** Atomically claim an email for processing by inserting its log row
 * with outcome "processing" BEFORE any work runs. Returns true if this
 * caller won the claim (inserted), false if another concurrent drain
 * already claimed it (unique-violation P2002). Closes the check-then-act
 * race where two drains both read "fresh" and both process the same
 * email -> duplicate expense. The row is updated to the final outcome by
 * logEmailDecision after processing. */
async function claimEmailForProcessing(
  connectionId: string,
  emailId: string,
  fromAddress: string,
  subject: string,
): Promise<boolean> {
  try {
    await db.orm.public.EmailProcessLog.create({
      connectionId,
      emailId,
      fromAddress,
      subject: subject.slice(0, 500),
      matched: false,
      outcome: "processing",
      error: null,
      createdAt: fromIso(new Date().toISOString()),
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return false;
    }
    throw err;
  }
}

async function seenEmail(
  connectionId: string,
  emailId: string,
): Promise<boolean> {
  const row = await db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connectionId), l.emailId.eq(emailId)),
  )
    .select("outcome")
    .first();
  return row !== null;
}

/** Prisma 8 has no atomic increment in the ORM lane; read then bump. A
 * lost update only undercounts a stat, never loses data. */
async function bumpCounter(
  connectionId: string,
  field: "receivedCount" | "processedCount",
): Promise<void> {
  const row = await db.orm.public.EmailConnection.where({ id: connectionId })
    .select(field)
    .first();
  await db.orm.public.EmailConnection.where({ id: connectionId }).update({
    [field]: (row?.[field] ?? 0) + 1,
  } as { receivedCount?: number; processedCount?: number });
}

async function bumpReceived(connectionId: string): Promise<void> {
  await bumpCounter(connectionId, "receivedCount");
}

async function bumpProcessed(connectionId: string): Promise<void> {
  await bumpCounter(connectionId, "processedCount");
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
 * logged and returned, never thrown; only the drain's adapter failures
 * propagate (they stop the batch).
 *
 * `options.review` is the inbox-review flow (/email-review): the user
 * explicitly chose this email, so the rule gate and the local receipt gate
 * are skipped (their judgment is the gate) and the model is allowed
 * (localOnly false) so attachment receipts and unparseable totals still
 * work. The log row is already in `pending-review`; the claim flips it to
 * `processing` in place instead of inserting, and a failure flips it back
 * to `pending-review` so the item stays on the list for a retry.
 */
export async function processConnectionEmail(
  connection: EmailConnectionWithSecret,
  summary: ConnectionEmailSummary,
  deps: InboundDeps,
  adapters: {
    moveToTrash: (id: string) => Promise<void>;
    sendToOwner: (email: OwnerEmail) => Promise<void>;
  },
  options: { review?: boolean } = {},
): Promise<ConnectionEmailResult> {
  const review = options.review === true;
  const fromAddress = extractEmailAddress(summary.from ?? "");
  const log = (
    outcome: LogOutcome,
    matched: boolean,
    opts: { reason?: string; expenseId?: string; error?: string } = {},
  ) =>
    logEmailDecision({
      connectionId: connection.id,
      emailId: summary.id,
      fromAddress,
      subject: summary.subject,
      matched,
      outcome,
      reason: opts.reason,
      expenseId: opts.expenseId,
      error: opts.error,
    });

  // Atomic claim BEFORE any work: insert the log row with outcome
  // "processing". If another concurrent drain already claimed this
  // emailId (unique violation), skip. This is the guard against the
  // duplicate-expense race (two drains both read "fresh" and both process
  // the same email). The row is updated to the final outcome by `log`
  // below; bumpReceived is tied to the claim so the counter only moves
  // for the winning drain.
  //
  // Review mode: the scan already inserted the row as `pending-review`.
  // Claim by flipping it to `processing` in place; if zero rows update,
  // another drain/click claimed it first (or it left the list).
  if (review) {
    const claimed = await db.orm.public.EmailProcessLog.where((l) =>
      and(
        l.connectionId.eq(connection.id),
        l.emailId.eq(summary.id),
        l.outcome.eq("pending-review"),
      ),
    ).updateAll({ outcome: "processing", error: null });
    if (claimed.length === 0) {
      return { status: "ignored", reason: "already processed" };
    }
  } else if (
    !(await claimEmailForProcessing(
      connection.id,
      summary.id,
      fromAddress,
      summary.subject,
    ))
  ) {
    return { status: "ignored", reason: "already processed" };
  }
  await bumpReceived(connection.id);

  // Our own notification emails (sent to self) must never be processed.
  // Skipped in review mode: the user chose a specific email, and a receipt
  // they forwarded to themselves is legitimate; the loop guard below still
  // catches the app's own confirmations by header.
  if (!review && fromAddress === connection.emailAddress) {
    await log("ignored", false, { reason: "self" });
    return { status: "ignored", reason: "self" };
  }

  // Bounces/autoreplies: never import, never answer.
  if (looksLikeBounce({ subject: summary.subject, from: summary.from ?? "" })) {
    await log("ignored", false, { reason: "bounce" });
    return { status: "ignored", reason: "bounce" };
  }

  // Rules decide what's even worth looking at, except in review mode,
  // where the user's explicit choice replaces the rule gate. A matched
  // rule still names a first-time merchant and sets the `matched` flag.
  const rule = await matchEmailRule(connection.accountId, summary.from ?? "");
  if (!review && !rule) {
    await log("ignored", false);
    return { status: "ignored", reason: "no rule" };
  }

  try {
    const email = await deps.fetchReceivedEmail(summary.id);
    if (isDeliveryNotification(email.headers)) {
      await log("ignored", true, { reason: "bounce" });
      return { status: "ignored", reason: "bounce" };
    }

    // Loop guard: the app's own outbound confirmations carry the
    // X-Expense-Confirmation header. If one lands back in the Inbox (it's
    // self for the connected flow, but a rule could match its sender),
    // skip it: never reprocess the app's own output. Header-based, stable.
    if (hasOwnConfirmationHeader(email.headers)) {
      await log("ignored", true, { reason: "own confirmation" });
      return { status: "ignored", reason: "own confirmation" };
    }

    // PRECISION-FIRST gate for the auto drain: a "receipt" verdict must
    // never fire for non-receipt mail, even with amounts in the body
    // (bank alerts, payment-status notices, newsletters with prices were
    // all misimported by the old body-amount rule). not-receipt AND
    // uncertain both skip: the email stays in the Inbox untouched.
    // Review mode keeps the looser gate — the user's explicit choice is
    // the gate there.
    const classification = classifyReceiptEmail({
      fromAddress: summary.from ?? "",
      subject: summary.subject,
      bodyText: email.text ?? htmlToText(email.html ?? ""),
    });
    if (!review && classification.verdict !== "receipt") {
      await log("ignored", true, { reason: classification.reason });
      return { status: "ignored", reason: classification.reason };
    }

    const attachments = await deps.listAttachments(summary.id);
    const selected = await selectReceiptSource(email, attachments, deps);
    if (!selected.source) {
      // Rule matched but there's nothing usable: ignore, leave in Inbox.
      await log("ignored", true, { reason: "no receipt content" });
      return { status: "ignored", reason: "no receipt content" };
    }

    // Receipt verdict → the local fast path (no model). Uncertain → the
    // LLM extraction runs and its isReceipt verdict gates the import (the
    // rules couldn't tell; the model is the fallback). Review mode keeps
    // the LLM available too — the user's explicit choice is the gate.
    const extracted = await extractReceiptFromSource({
      accountId: connection.accountId,
      email,
      attachments,
      source: selected.source,
      deps,
      localOnly: !review && classification.verdict === "receipt",
      review,
      ruleSender: rule?.sender,
    });
    if (!extracted) {
      if (review) {
        // Review mode: the user chose this email but nothing readable came
        // out of it (not a receipt, no total, unreadable attachment). Stay
        // on the list so they can retry or ignore; surface the reason.
        await log("pending-review", true, { error: "no receipt content" });
        return {
          status: "error",
          error: "We couldn't read a receipt from this email.",
        };
      }
      // Body receipt whose total couldn't be parsed locally, or an
      // attachment receipt: skip, leave in Inbox for manual review.
      await log("ignored", true, { reason: "not extractable locally" });
      return { status: "ignored", reason: "not extractable locally" };
    }

    // Duplicate guard (auto mode): the same receipt (merchant + amount +
    // date) imported within the recent window — two copies of one email
    // arrived, or the push and the drain raced. Skip the import entirely:
    // the email stays in the Inbox and the duplicate is surfaced via
    // captureWarning (the designed duplicate alarm, EXPENSE-P).
    if (!review) {
      const duplicate = await findRecentlyImportedMatch(connection.accountId, {
        merchant: extracted.extraction.merchant,
        amount: extracted.extraction.amount,
        date: selected.expenseDate,
        description: extracted.extraction.description,
        excludeExpenseId: "",
      });
      if (duplicate) {
        await log("ignored", true, { reason: "duplicate of a recent import" });
        captureWarning(
          "[email-connections] duplicate receipt skipped — same receipt imported recently",
          {
            connectionId: connection.id,
            emailId: summary.id,
            matchedExpenseId: duplicate.id,
          },
        );
        return { status: "ignored", reason: "duplicate" };
      }
    }

    const saved = await saveExpenseFromExtraction({
      accountId: connection.accountId,
      expenseDate: selected.expenseDate,
      extraction: extracted.extraction,
      receiptImage: extracted.receiptImage,
      imageMime: extracted.imageMime,
      originalName: extracted.originalName,
      originalSource: selected.source,
    });

    // Success (complete or partial): move to Trash, notify the owner.
    // A Trash failure keeps the email in the Inbox; the log row prevents
    // a duplicate expense on the next drain, and the user still has the mail.
    await adapters.moveToTrash(summary.id);
    mimeCache.invalidate(`${connection.id}:${summary.id}`);

    const confirmation = confirmationEmail({
      expenseId: saved.expenseId,
      date: selected.expenseDate,
      merchant: extracted.extraction.merchant,
      amount: extracted.extraction.amount,
      category: saved.category,
      report: saved.report,
      description: extracted.extraction.description,
      notes: confirmationNotes({
        notes: extracted.extraction.notes,
        currency: extracted.extraction.currency,
        renderError: extracted.renderError,
      }),
      intro: review
        ? "You processed this email as an expense. Here's what we found:"
        : "This email was imported automatically as an expense. Here's what we found:",
      missing: saved.missing,
      reportStats: saved.reportStats,
    });
    if (saved.recentMatch) {
      // The same receipt was already imported within the recent window by
      // receipts-by-email pipeline (the forwarded copy), so the owner
      // already got a confirmation. Suppress this one; log + alert so a
      // false match stays visible.
      console.info(
        "[email-connections] confirmation suppressed — same receipt imported recently",
        {
          connectionId: connection.id,
          emailId: summary.id,
          matchedExpenseId: saved.recentMatch.id,
          matchedAt: saved.recentMatch.createdAt,
        },
      );
      captureWarning(
        "[email-connections] duplicate confirmation suppressed — same receipt imported recently",
        {
          connectionId: connection.id,
          emailId: summary.id,
          matchedExpenseId: saved.recentMatch.id,
        },
      );
    } else {
      await adapters.sendToOwner({
        subject: confirmation.subject,
        html: confirmation.html,
        text: confirmation.text,
        attachments: saved.receiptAttachment
          ? [saved.receiptAttachment]
          : undefined,
      });
    }

    // A notification processed into an expense is its charge's RECORD, not
    // a cover for other notifications: inbox review's burst matching must
    // not count it as a receipt that can supersede a sibling notification
    // for a different same-amount charge. The marker carries the expense
    // id so the review scan can exclude exactly this expense.
    // Every processed email is stamped with the expense it created. The
    // row's receivedAt is the EMAIL's arrival (written at scan/claim
    // time, not processing time), so the expenseId gives inbox review
    // the receipt's arrival moment: the charge-time signal it matches
    // bank-notification bursts against (alerts land within a minute of
    // the charge, the receipt minutes to an hour later). Notification
    // rows are recognizable by their subject/fromAddress (a notification
    // is the charge's RECORD, never a cover for sibling notifications).
    await log(saved.missing.length > 0 ? "partial" : "created", true, {
      expenseId: saved.expenseId,
      reason:
        saved.missing.length > 0
          ? `Missing: ${saved.missing.join(", ")}`
          : undefined,
    });
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
    if (review) {
      // Review mode: keep the item on the list (outcome back to
      // pending-review) so the user can retry or ignore; the error message
      // is recorded on the row and surfaced in the UI.
      await log("pending-review", true, { error: message });
    } else {
      await log("error", true, { error: message });
    }
    return { status: "error", error: message };
  }
}

// --- Drain -----------------------------------------------------------------------

export interface DrainOptions {
  /** Mailbox operations; defaults to the real JMAP adapter (user token). */
  adapter?: ConnectionMailAdapter;
  extractionDeps?: ConnectionDeps;
  /** Lookback window for the Inbox query (default 3 days; pushes are
   * near-real-time, and this is the missed-push catch-up). */
  lookbackMs?: number;
  /** Max emails per query batch (default 10). */
  batchSize?: number;
  /** Time budget before stopping mid-backlog (default 45s, headroom in 60s). */
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
 * The default mail adapter for a connected account: inbox summaries, raw
 * email reads, and Trash moves, all with the account's token. Callers with
 * their own needs override a method (the review scan swaps in a no-op
 * Trash; the drain script swaps in a role-picked mailbox).
 */
export function connectionMailAdapter(token: string): ConnectionMailAdapter {
  return {
    inboxEmailSummaries: (opts) => inboxEmailSummaries({ token, ...opts }),
    rawEmail: (id) => rawConnectionEmail(token, id),
    moveToTrash: (id) => moveConnectionEmailToTrash(token, id),
  };
}

/**
 * Drain new Inbox mail for one connection: evaluate each unseen email,
 * create expenses for receipts, Trash + notify on success. Bounded by a
 * time budget; the daily cron re-runs it as the catch-up net.
 *
 * The scan is cursor-based over receivedAt: each batch advances the cursor
 * past the newest email it returned, so a batch with no fresh mail just
 * slides the window forward instead of stopping the drain. Without that,
 * a front of already-evaluated mail (ignored newsletters, self mail that
 * stays in the Inbox) blocks the catch-up from ever reaching newer mail:
 * the Shopify bill sat behind a wall of seen email and was never reached
 * by the cron.
 * Counters: receivedCount bumps per newly-evaluated email, processedCount
 * per created/partial.
 */
export async function drainEmailConnection(
  connection: EmailConnectionWithSecret,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const token = decryptSecret(connection.tokenEnc);
  const adapter = options.adapter ?? connectionMailAdapter(token);
  const extractionDeps = options.extractionDeps ?? realExtractionDeps();
  const deps = connectionInboundDeps(connection.id, adapter, extractionDeps);

  const lookbackMs = options.lookbackMs ?? 3 * 24 * 60 * 60 * 1000;
  const batchSize = options.batchSize ?? 10;
  const budgetMs = options.timeBudgetMs ?? 45_000;
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

  // Cursor over receivedAt: starts at the lookback floor, advances past
  // each scanned batch. +1ms so the (exclusive) JMAP `after` filter always
  // moves strictly forward regardless of same-timestamp batches.
  let cursorMs = started - lookbackMs;
  let afterIso = new Date(cursorMs).toISOString();

  while (Date.now() - started <= budgetMs) {
    const summaries = await adapter.inboxEmailSummaries({
      afterIso,
      limit: batchSize,
    });
    if (summaries.length === 0) break;
    // Skip already-evaluated emails (push + cron race, re-delivered mail).
    const fresh: ConnectionEmailSummary[] = [];
    for (const summary of summaries) {
      if (!(await seenEmail(connection.id, summary.id))) fresh.push(summary);
    }
    // The batch's newest email (summaries are oldest-first); the cursor
    // slides to just past it.
    const newestMs = Date.parse(summaries[summaries.length - 1]!.receivedAt);
    const nextMs = Number.isNaN(newestMs) ? cursorMs : newestMs + 1;

    if (fresh.length === 0) {
      // Nothing new in this batch: advance past it and keep scanning;
      // newer mail may still be waiting behind this wall of seen email.
      if (nextMs <= cursorMs) break; // no forward progress (defensive)
      cursorMs = nextMs;
      afterIso = new Date(cursorMs).toISOString();
      continue;
    }

    for (const summary of fresh) {
      if (Date.now() - started > budgetMs) {
        console.warn("[email-connections] drain time budget reached", {
          connectionId: connection.id,
        });
        return result;
      }
      result.evaluated++;
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
    // Processed emails are either trashed (gone from the Inbox) or seen;
    // slide the window past the batch so the next query doesn't re-serve it.
    if (nextMs > cursorMs) {
      cursorMs = nextMs;
      afterIso = new Date(cursorMs).toISOString();
    }
  }
  return result;
}

/** Deliver the confirmation to the mailbox owner's own Inbox by writing it
 * via JMAP (the API token can't submit/send, only write mail), so the
 * owner sees it appear in their Inbox. Exported for the review flow. */
export async function sendConnectionEmailToOwner(
  connection: EmailConnectionWithSecret,
  token: string,
  email: OwnerEmail,
): Promise<void> {
  const ok = await deliverConnectionEmailToInbox(
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
