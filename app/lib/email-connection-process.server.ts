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
import type { SendEmailInput } from "~/lib/email-mime.server";
import {
  createMimeInboundCache,
  mimeFetchDeps,
} from "~/lib/mime-inbound.server";
import { evaluateAuthChain } from "~/lib/email-auth.server";
import {
  captureError,
  captureWarning,
  errorSummary,
} from "~/lib/errors.server";
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
import {
  gmailMailAdapter,
  gmailSendConnectionEmailToOwner,
} from "~/lib/gmail.server";
import {
  connectionAuthservIds,
  connectionCredential,
  type ConnectionCredential,
} from "~/lib/email-connection-auth.server";
import type { JmapServer } from "~/lib/jmap.server";
import { matchEmailRule } from "~/lib/db/email-rules";
import { findRecentlyImportedMatch } from "~/lib/db/expenses";
import {
  readEmailLogSnapshots,
  readStaleClaimArrivals,
  writeEmailLogRow,
  type EmailLogSnapshot,
} from "~/lib/db/email-log";
import {
  classifyReceiptEmail,
  hasOwnConfirmationHeader,
} from "~/lib/email-classify";
import { htmlToText } from "~/lib/html-text";
import * as Sentry from "@sentry/react-router";
import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { fromIso, nowWire } from "~/lib/db/wire";
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
  /** The authserv-ids whose delivery stamp is trusted for this mailbox: the
   * authentication chain only counts records from one of them. */
  authservIds: string[],
  adapter: ConnectionMailAdapter,
  extractionDeps: ConnectionDeps,
): InboundDeps {
  return {
    ...mimeFetchDeps(mimeCache, adapter, {
      // Cache keys are namespaced per connection so one shared cache serves
      // every connected account in the process.
      cacheKey: (emailId) => `${connectionId}:${emailId}`,
      foreignAttachmentSuffix: "not produced by the connection adapter",
      authservIds,
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
  await writeEmailLogRow({
    connectionId: input.connectionId,
    emailId: input.emailId,
    update: {
      patch: {
        matched: input.matched,
        outcome: input.outcome,
        reason: input.reason ?? null,
        expenseId: input.expenseId ?? null,
        error: input.error ?? null,
      },
    },
    create: {
      fromAddress: input.fromAddress,
      subject: input.subject.slice(0, 500),
      matched: input.matched,
      outcome: input.outcome,
      reason: input.reason ?? null,
      expenseId: input.expenseId ?? null,
      error: input.error ?? null,
      createdAt: fromIso(now),
    },
    // A collision here means the row this decision was rewriting vanished
    // and something re-created it: not a normal outcome, so let it out.
    onUniqueViolation: "throw",
  });
}

/** How long a claim may sit on `processing` before another drain may take it
 * over. No live request can hold one that long (the drain's own budget is
 * 45s and the route's limit is 60s), so a row past this age belongs to a
 * worker that died mid-flight. Without the takeover the email is stranded:
 * the drain reads any existing row as a finished email and the review scan
 * leaves `processing` alone, so nothing would ever look at it again. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** The instant before which a `processing` claim is stale. Both halves of
 * the takeover rule ask for it — the SQL predicate that lets
 * `claimEmailForProcessing` take over a dead worker's claim, and the
 * in-memory predicate that offers the email to the drain again — so the
 * boundary is computed once. If the two disagreed, a takeover would be
 * unreachable in one direction and a live claim could be stolen in the
 * other. */
function staleClaimCutoffMs(nowMs: number): number {
  return nowMs - STALE_CLAIM_MS;
}

/** Atomically claim an email for processing by writing its log row with
 * outcome "processing" BEFORE any work runs. Returns true if this caller
 * won the claim, false if a live claim for the email is already there
 * (another concurrent drain: the unique-violation P2002 path). Closes the
 * check-then-act race where two drains both read "fresh" and both process
 * the same email -> duplicate expense. The row is updated to the final
 * outcome by logEmailDecision after processing. */
async function claimEmailForProcessing(
  connectionId: string,
  emailId: string,
  fromAddress: string,
  subject: string,
  /** The EMAIL's arrival, not the processing time: inbox review matches
   * bank-notification bursts against arrival, so a receipt the drain filed
   * must carry it or the charge it covers looks unpaid. */
  receivedAt: string,
): Promise<boolean> {
  // A stale claim is taken over in place (the email may still be in the
  // Inbox after a crash, and re-running is what a fresh claim would do);
  // anything younger is another drain's claim and stays its business.
  const claim = {
    fromAddress,
    subject: subject.slice(0, 500),
    matched: false,
    outcome: "processing",
    error: null,
    receivedAt: fromIso(receivedAt),
    createdAt: nowWire(),
  };
  const claimed = await writeEmailLogRow({
    connectionId,
    emailId,
    update: {
      patch: claim,
      updatable: (l) =>
        and(
          l.outcome.eq("processing"),
          l.createdAt.lt(
            fromIso(new Date(staleClaimCutoffMs(Date.now())).toISOString()),
          ),
        ),
    },
    create: claim,
    onUniqueViolation: "race",
  });
  return claimed === "created" || claimed === "updated";
}

/** Which of a batch's emails are already settled, decided in memory from ONE
 * read of the batch's log rows. A row in any state answers yes, except a
 * claim that outlived the worker holding it: `claimEmailForProcessing` takes
 * those over, so the drain has to offer the email again or that takeover is
 * unreachable (a drain killed mid-flight would leave the email sitting in
 * the Inbox forever, invisible to the drain and to /email-review alike, and
 * the receipt would never be filed).
 *
 * The per-email read this replaced cost one pooled round trip per email
 * before the batch began any work: a `pg-pool.connect` N+1 in production
 * (Sentry EXPENSE-1F). */
function settledEmailIds(
  snapshots: EmailLogSnapshot[],
  nowMs: number,
): Set<string> {
  const settled = new Set<string>();
  for (const row of snapshots) {
    const stale = Date.parse(row.createdAt) < staleClaimCutoffMs(nowMs);
    if (row.outcome !== "processing" || !stale) settled.add(row.emailId);
  }
  return settled;
}

/** How far back of a completed walk a resumed one starts. Mail that arrives
 * while a walk is running can land behind its cursor, so the next walk must
 * re-cover the whole interval the previous one ran over rather than only the
 * part of it that was still ahead; starting at the previous walk's start is
 * what makes that lossless. The slack on top absorbs the delivery latency
 * between the mailbox's `receivedAt` and this app's clock. */
const WALK_RESUME_OVERLAP_MS = 60 * 1000;

/** Where a connection's mailbox walk starts. With no resume point that is the
 * lookback floor — the whole window, and the conservative default.
 *
 * With one, the walk re-covers the interval since the previous COMPLETED walk
 * began, and that is enough: mail older than that start was read by that walk
 * (it read forward from its own floor), and mail that arrived while it ran is
 * re-covered, because the interval starts where that walk did. A walk that was
 * cut short — the time budget, or the process dying — records no resume point,
 * so the next one starts from the previous completed walk and re-covers it.
 *
 * The one row that can outlive a completed walk is a claim older than the stale
 * cutoff: a drain killed while holding it. Its arrival pulls the floor back to
 * itself, because `claimEmailForProcessing` can only take that claim over if
 * the drain offers the email again, and the walk that would have offered it is
 * precisely the one that never finished. Left behind the floor, that email
 * would be invisible to the drain and to /email-review alike forever, and its
 * receipt would never be filed.
 *
 * The result is therefore never later than the lookback floor and never later
 * than the oldest row still waiting on an answer, which is what keeps a
 * resumed walk as complete as one that starts at the floor. */
export function drainWalkFloorMs(input: {
  nowMs: number;
  lookbackMs: number;
  lastWalkStartMs: number | null;
  oldestStaleClaimMs: number | null;
}): number {
  const windowFloorMs = input.nowMs - input.lookbackMs;
  const resumeFloorMs =
    input.lastWalkStartMs === null
      ? windowFloorMs
      : input.lastWalkStartMs - WALK_RESUME_OVERLAP_MS;
  const floorMs =
    input.oldestStaleClaimMs === null
      ? resumeFloorMs
      : Math.min(resumeFloorMs, input.oldestStaleClaimMs);
  return Math.max(windowFloorMs, floorMs);
}

/** Run one step of the drain, naming it if it throws. The caller sees only
 * "drain failed", and a stage-less throw from a five-step loop is unreadable
 * in a log line and unreadable in Sentry once the raw message trips its data
 * scrubber. The cause is kept, so the console still prints the real stack. */
async function drainStep<T>(stage: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new Error(`[email-connections] ${stage}: ${errorSummary(err)}`, {
      cause: err,
    });
  }
}

/** Bump a counter in a single atomic UPDATE: Postgres evaluates `col + n`
 * against the stored value, so two drains that interleave can't lose an
 * increment the way the old read-then-write could. The ORM lane takes
 * literals only, so this is the SQL builder with a raw expression per
 * column (pg/int4@1, the codec id prisma/contract.json gives both counters).
 * `by` is the batch's whole delta: one write covers a whole batch. */
async function bumpCounter(
  connectionId: string,
  field: "receivedCount" | "processedCount",
  by = 1,
): Promise<void> {
  await db.runtime().execute(
    db.sql.public.email_connections
      .update((f, fns) =>
        field === "receivedCount"
          ? {
              receivedCount: fns.raw`${f.receivedCount} + ${by}`.returns(
                "pg/int4@1",
              ),
            }
          : {
              processedCount: fns.raw`${f.processedCount} + ${by}`.returns(
                "pg/int4@1",
              ),
            },
      )
      .where((f, fns) => fns.eq(f.id, connectionId))
      .build(),
  );
}

/** Where a run's counter increments go. The drain collects them and writes
 * once per batch — one pooled round trip per email bought a number nobody
 * reads that often (Sentry EXPENSE-1F). A caller with a single email (the
 * inbox review click) leaves it unset and gets the write straight away, so
 * the number on screen is current the moment the click returns. */
export interface ConnectionCounters {
  received(): void;
  processed(): void;
}

/** The drain's counters: increments in memory, one UPDATE per counter per
 * flush. Two ways a batch's counts can be lost, both bounded by the batch
 * size and both display-only: a drain that dies before its flush, and a
 * flush whose two UPDATEs split (one commits, the other rejects — the
 * deltas are cleared before the await, so the rejected one is not retried).
 * Either way the connection is flagged at that point, and these are numbers
 * on a list page, not a ledger. */
function counterBatch(connectionId: string) {
  let received = 0;
  let processed = 0;
  return {
    received: () => {
      received += 1;
    },
    processed: () => {
      processed += 1;
    },
    flush: async () => {
      const writes: Promise<void>[] = [];
      if (received > 0) {
        writes.push(bumpCounter(connectionId, "receivedCount", received));
      }
      if (processed > 0) {
        writes.push(bumpCounter(connectionId, "processedCount", processed));
      }
      received = 0;
      processed = 0;
      await Promise.all(writes);
    },
  };
}

/** Count one email the drain evaluated. */
async function bumpReceivedCount(connectionId: string): Promise<void> {
  await bumpCounter(connectionId, "receivedCount");
}

/** Count one email that became an expense (auto drain or inbox review). */
export async function bumpProcessedCount(connectionId: string): Promise<void> {
  await bumpCounter(connectionId, "processedCount");
}

// --- Per-email processing ---------------------------------------------------------

export interface OwnerEmail {
  subject: string;
  html: string;
  text?: string;
  attachments?: SendEmailInput["attachments"];
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
  options: { review?: boolean; counters?: ConnectionCounters } = {},
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
      summary.receivedAt,
    ))
  ) {
    return { status: "ignored", reason: "already processed" };
  }
  // Everything past the claim runs inside the pipeline's try, so the row
  // always reaches a final outcome. A throw between the claim and the old
  // try (the rule gate is a DB read, and a missing table proved it can
  // fail) left the row on `processing` forever: the drain reads any row as
  // "already processed" and the review list leaves `processing` alone, so
  // that email was invisible to both. Caught here it becomes an `error`
  // row, which the review scan offers, or `pending-review` for a click.
  try {
    if (options.counters) {
      // The drain batches the write; a caller without a batch (the review
      // click) counts straight away.
      options.counters.received();
    } else {
      await bumpReceivedCount(connection.id);
    }

    // Our own notification emails (sent to self) must never be processed.
    // Skipped in review mode: the user chose a specific email, and a receipt
    // they forwarded to themselves is legitimate; the loop guard below still
    // catches the app's own confirmations by header.
    if (!review && fromAddress === connection.emailAddress) {
      await log("ignored", false, { reason: "self" });
      return { status: "ignored", reason: "self" };
    }

    // Bounces/autoreplies: never import, never answer.
    if (
      looksLikeBounce({ subject: summary.subject, from: summary.from ?? "" })
    ) {
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

    // INB-SPOOF-1 parity with the receipts-by-email pipeline: a rule match
    // decides which senders are worth looking at, not that this message really
    // came from the sender it claims. The From header is forgeable at SMTP
    // time, so the delivered message must also carry an authentication result
    // from the mailbox provider (Fastmail or Gmail) that passes and aligns
    // with From. Without this, a rule-matching From let anyone inject a fake
    // expense and have the mail moved to Trash. Failures stay in the Inbox and
    // remain importable from review, where the user's explicit choice is the
    // gate (same as the rule and classification gates below).
    if (!review) {
      const auth = evaluateAuthChain(
        email.authResults ?? [],
        summary.from ?? "",
      );
      if (!auth.ok) {
        await log("ignored", true, { reason: "failed authentication" });
        captureWarning(
          "[email-connections] message failed authentication; not importing",
          {
            emailId: summary.id,
            from: summary.from,
            reason: auth.reason,
          },
        );
        return { status: "ignored", reason: "failed authentication" };
      }
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
    if ("duplicateOf" in saved) {
      // The same receipt image is already an expense (any import route).
      // Review keeps the item listed with the reason so the user decides;
      // auto drops it exactly like the content guard above.
      if (review) {
        await log("pending-review", true, {
          error: "The same receipt image was already imported.",
        });
        return {
          status: "error",
          error:
            "The same receipt image was already imported as another expense.",
        };
      }
      await log("ignored", true, { reason: "duplicate image" });
      captureWarning(
        "[email-connections] duplicate receipt skipped — same image already imported",
        {
          emailId: summary.id,
          matchedExpenseId: saved.duplicateOf,
        },
      );
      return { status: "ignored", reason: "duplicate" };
    }

    // Success (complete or partial): move to Trash, notify the owner.
    // A Trash failure keeps the email in the Inbox; the log row prevents
    // a duplicate expense on the next drain, and the user still has the mail.
    await adapters.moveToTrash(summary.id);
    mimeCache.invalidate(`${connection.id}:${summary.id}`);

    const confirmation = confirmationEmail({
      expenseId: saved.expenseId,
      date: selected.expenseDate,
      merchant: extracted.extraction.merchant,
      amount: saved.fx?.amount ?? extracted.extraction.amount,
      category: saved.category,
      report: saved.report,
      description: extracted.extraction.description,
      notes: confirmationNotes({
        notes: extracted.extraction.notes,
        currency: saved.currency,
        fx: saved.fx,
        renderError: extracted.renderError,
      }),
      intro: review
        ? "You processed this email as an expense. Here's what we found:"
        : "This email was imported automatically as an expense. Here's what we found:",
      missing: saved.missing,
      reportStats: saved.reportStats,
      receipt: saved.receiptAttachment,
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
          emailId: summary.id,
          matchedExpenseId: saved.recentMatch.id,
        },
      );
    } else {
      await adapters.sendToOwner({
        subject: confirmation.subject,
        html: confirmation.html,
        text: confirmation.text,
        attachments: confirmation.attachments,
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
 * email reads, and Trash moves, all against the connection's JMAP server.
 * Callers with their own needs override a method (the review scan swaps in
 * a no-op Trash; the drain script swaps in a role-picked mailbox).
 */
export function connectionMailAdapter(
  server: JmapServer,
): ConnectionMailAdapter {
  return {
    inboxEmailSummaries: (opts) => inboxEmailSummaries({ server, ...opts }),
    rawEmail: (id) => rawConnectionEmail(server, id),
    moveToTrash: (id) => moveConnectionEmailToTrash(server, id),
  };
}

/** Adapter + owner-notification transport for one connection. The one
 * branch point between the JMAP and Gmail paths: everything downstream
 * (drain, review) is provider-agnostic. */
export interface ConnectionMailClient {
  adapter: ConnectionMailAdapter;
  sendToOwner(email: OwnerEmail): Promise<void>;
}

export function mailClientFor(
  connection: EmailConnectionWithSecret,
  credential: ConnectionCredential,
): ConnectionMailClient {
  if (credential.kind === "gmail") {
    const token = credential.token;
    return {
      adapter: gmailMailAdapter(token),
      sendToOwner: (email) =>
        gmailSendConnectionEmailToOwner(connection, token, email),
    };
  }
  return {
    adapter: connectionMailAdapter(credential.server),
    sendToOwner: (email) =>
      sendConnectionEmailToOwner(connection, credential.server, email),
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
 *
 * Everything runs in one isolation scope per connection, so the captures
 * along the way carry the connection and account as tags instead of each
 * one copying those ids into `extra`. The cron path already had a scope
 * (withMonitor forks one); the push and script paths did not.
 *
 * Bursts are collapsed by `coalesceDrain` below: a push burst costs the run in
 * flight plus one trailing run, not one full mailbox walk per push.
 */

/** The run in flight for a connection, plus at most one trailing run. */
interface DrainSlot {
  current: Promise<unknown>;
  trailing: Promise<unknown> | null;
}

const drainSlots = new Map<string, DrainSlot>();

/** When each connection's last COMPLETED mailbox walk began, by connection id.
 * Per serverless instance, like `drainSlots`, and never persisted: an instance
 * that has not walked a connection starts it at the lookback floor, which is
 * the safe default and what a cold instance (the daily cron usually is one)
 * still does. An entry left over from long ago only widens the interval the
 * next walk re-covers, so it costs work, never correctness. */
const walkStarts = new Map<string, number>();

/**
 * Collapse a burst of drains for one connection into the run in flight plus
 * at most ONE trailing run. Exported for the unit test; the drain entry point
 * is the only caller in app code.
 *
 * Fastmail delivers pushes in bursts — nine inside seven seconds on
 * 2026-10-06 — and each one used to re-walk the same window of
 * already-evaluated mail, paying a mailbox read plus a `readEmailLogSnapshots`
 * query per batch (Sentry EXPENSE-1F, and EXPENSE-1J once the pool-checkout
 * spans behind 1F were ignored and the detector regrouped onto the queries
 * themselves). Coalescing caps one burst at those two walks; `drainWalkFloorMs`
 * is what keeps each of them off the mail that is already settled.
 *
 * The trailing run is what makes this lossless rather than merely cheaper:
 * it starts strictly after the run it follows, so mail that arrived while
 * that run was still walking the mailbox is inside its lookback window. A
 * caller that simply joined the in-flight run would drop exactly the mail its
 * own push announced, because that run's last batch read had already passed
 * the point where the mail landed.
 *
 * State is per serverless instance, so a burst spread over several lambdas
 * coalesces per instance — which is still where the repeats land.
 */
export function coalesceDrain<T>(
  connectionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const slot = drainSlots.get(connectionId);
  if (!slot) {
    const fresh: DrainSlot = { current: run(), trailing: null };
    drainSlots.set(connectionId, fresh);
    void fresh.current
      .catch(() => undefined)
      .finally(() => {
        // Only the last run standing clears the slot; if a trailing run was
        // scheduled, its own cleanup owns the delete.
        if (drainSlots.get(connectionId) === fresh && !fresh.trailing) {
          drainSlots.delete(connectionId);
        }
      });
    return fresh.current as Promise<T>;
  }
  if (!slot.trailing) {
    const trailing = slot.current.catch(() => undefined).then(run);
    slot.trailing = trailing;
    void trailing
      .catch(() => undefined)
      .finally(() => {
        if (drainSlots.get(connectionId) === slot)
          drainSlots.delete(connectionId);
      });
  }
  return slot.trailing as Promise<T>;
}

export function drainEmailConnection(
  connection: EmailConnectionWithSecret,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const run = (resumeFromLastWalk: boolean) => () =>
    Sentry.withIsolationScope((scope) => {
      scope.setTag("connection", connection.id);
      scope.setTag("account", connection.accountId);
      return drainConnection(connection, options, resumeFromLastWalk);
    });
  // Any option at all means the caller supplied its own adapter, extraction
  // deps or window — the dev route and every test. Those must never join a
  // production drain (or another test's), so they always run standalone, and
  // they always walk the whole lookback window: resuming is a production-only
  // saving, and sharing a resume point would make a test's walk depend on the
  // test that ran before it.
  if (Object.keys(options).length > 0) return run(false)();
  return coalesceDrain(connection.id, run(true));
}

/** The drain itself; drainEmailConnection owns the isolation scope it runs in,
 * and decides whether the walk may resume from the last one. */
async function drainConnection(
  connection: EmailConnectionWithSecret,
  options: DrainOptions = {},
  resumeFromLastWalk = false,
): Promise<DrainResult> {
  const credential = await drainStep("resolving the credential failed", () =>
    connectionCredential(connection),
  );
  const client = mailClientFor(connection, credential);
  const adapter = options.adapter ?? client.adapter;
  const extractionDeps = options.extractionDeps ?? realExtractionDeps();
  // Fail closed: an unpinned generic JMAP connection with no learnable
  // delivery stamp must not run, because evaluateAuthChain([]) answers ok
  // ("legacy transport") and would open the sender-authentication gate.
  const authservIds = await drainStep(
    "reading the delivery authentication stamp failed",
    () => connectionAuthservIds(connection, credential),
  );
  if (authservIds === null) {
    captureWarning(
      `[email-connections] no delivery authentication stamp yet for ${connection.emailAddress}`,
      { emailAddress: connection.emailAddress },
    );
    return { evaluated: 0, created: 0, partial: 0, ignored: 0, failed: 0 };
  }
  const deps = connectionInboundDeps(
    connection.id,
    authservIds,
    adapter,
    extractionDeps,
  );

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
    sendToOwner: (email: OwnerEmail) => client.sendToOwner(email),
  };
  // The batch's counter deltas, written once when the batch ends.
  const counters = counterBatch(connection.id);

  // Cursor over receivedAt, advancing past each scanned batch. +1ms so the
  // (exclusive) JMAP `after` filter always moves strictly forward regardless
  // of same-timestamp batches. Where it starts is the whole point of the
  // resume point: a push re-covers the interval since the last completed walk
  // instead of the lookback window, which is the difference between one
  // mailbox read per push and one per batch of mail that is already settled
  // (Sentry EXPENSE-1J). Everything older is either settled already or was
  // covered by the walk that set the resume point; drainWalkFloorMs carries
  // the argument, including the row that can still sit behind it.
  const lastWalkStartMs = resumeFromLastWalk
    ? (walkStarts.get(connection.id) ?? null)
    : null;
  let oldestStaleClaimMs: number | null = null;
  if (lastWalkStartMs !== null) {
    // Only a resume point can leave a claim behind the floor, so the read is
    // only worth making when there is one.
    const arrivals = await drainStep("reading the stale claim failed", () =>
      readStaleClaimArrivals(
        connection.id,
        new Date(staleClaimCutoffMs(started)).toISOString(),
      ),
    );
    // Oldest first, so the head is the earliest claim that can be placed on
    // the mailbox's timeline. One with no recorded arrival sits nowhere on it,
    // and nothing narrower than the whole window is safe for it; the window
    // floor is how that is said here (drainWalkFloorMs clamps to the same one).
    // Neither writer can produce such a row today — the claim insert and the
    // review upsert both write receivedAt — but a rescued claim must not rest
    // on that.
    const oldest = arrivals[0];
    if (arrivals.includes(null)) {
      oldestStaleClaimMs = started - lookbackMs;
    } else if (typeof oldest === "string") {
      oldestStaleClaimMs = Date.parse(oldest);
    }
  }
  let cursorMs = drainWalkFloorMs({
    nowMs: started,
    lookbackMs,
    lastWalkStartMs,
    oldestStaleClaimMs,
  });
  let afterIso = new Date(cursorMs).toISOString();

  let walkCoveredWholeWindow = false;
  while (Date.now() - started <= budgetMs) {
    const summaries = await drainStep("reading the mailbox failed", () =>
      adapter.inboxEmailSummaries({
        afterIso,
        limit: batchSize,
      }),
    );
    if (summaries.length === 0) {
      // The window is exhausted, so this walk reached the present: the only
      // exit that has covered everything from its floor onward, and so the
      // only one that earns a resume point for the next walk.
      walkCoveredWholeWindow = true;
      break;
    }
    // Skip already-evaluated emails (push + cron race, re-delivered mail).
    // One read for the whole batch: this filter runs before any work, so a
    // per-email read put a round trip in front of every batched email.
    const settled = settledEmailIds(
      await drainStep("reading the process log failed", () =>
        readEmailLogSnapshots(
          connection.id,
          summaries.map((s) => s.id),
        ),
      ),
      Date.now(),
    );
    const fresh = summaries.filter((s) => !settled.has(s.id));
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
        // Flush first: the emails already counted in this batch are real.
        await drainStep("counting the batch failed", counters.flush);
        captureWarning("[email-connections] drain time budget reached", {
          evaluated: result.evaluated,
        });
        return result;
      }
      result.evaluated++;
      const outcome = await drainStep(`processing ${summary.id} failed`, () =>
        processConnectionEmail(connection, summary, deps, adapters, {
          counters,
        }),
      );
      switch (outcome.status) {
        case "created":
          result.created++;
          counters.processed();
          break;
        case "partial":
          result.partial++;
          counters.processed();
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
    await drainStep("counting the batch failed", counters.flush);
    // Processed emails are either trashed (gone from the Inbox) or seen;
    // slide the window past the batch so the next query doesn't re-serve it.
    if (nextMs > cursorMs) {
      cursorMs = nextMs;
      afterIso = new Date(cursorMs).toISOString();
    }
  }
  // Record the resume point only for a walk that covered the window; one cut
  // short by the budget or killed outright leaves it alone, so the next walk
  // starts where the last completed one did and re-covers what this one
  // missed.
  if (resumeFromLastWalk && walkCoveredWholeWindow) {
    walkStarts.set(connection.id, started);
  }
  return result;
}

/** Deliver the confirmation to the mailbox owner's own Inbox. On JMAP
 * (Fastmail) it is written via Email/import (the API token can't send);
 * the Gmail branch routes to the gmail importer in mailClientFor. */
async function sendConnectionEmailToOwner(
  connection: EmailConnectionWithSecret,
  server: JmapServer,
  email: OwnerEmail,
): Promise<void> {
  const ok = await deliverConnectionEmailToInbox(
    server,
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
      { to: connection.emailAddress },
    );
  }
}
