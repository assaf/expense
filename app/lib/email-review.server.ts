import { htmlToText } from "~/lib/html-text";
import {
  looksLikeReceiptEmail,
  isTransactionNotification,
  notificationChargeAmount,
} from "~/lib/email-classify";
import { FREE_MAIL_DOMAINS } from "~/lib/email-connection-infer.server";
import { decryptSecret } from "~/lib/token-crypto.server";
import {
  addEmailRule,
  matchEmailRule,
  ruleSenderMatches,
} from "~/lib/db/email-rules";
import { findChargeExpenses } from "~/lib/db/expenses";
import { extractEmailAddress } from "~/lib/validation";
import {
  type ConnectionDeps,
  type ConnectionMailAdapter,
  type OwnerEmail,
  connectionInboundDeps,
  connectionMailAdapter,
  processConnectionEmail,
  realExtractionDeps,
  sendConnectionEmailToOwner,
} from "~/lib/email-connection-process.server";
import type { ConnectionEmailSummary } from "~/lib/email-connection-mail.server";
import { and, or } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { isUniqueViolation } from "~/lib/db/pg-errors";
import { fromIso, toIso } from "~/lib/db/wire";
import { captureError } from "~/lib/errors.server";
import type { EmailConnectionWithSecret } from "~/lib/db/email-connections";

/**
 * Inbox review (/email-review): after connecting a mailbox, the user scans
 * the Inbox for receipt-like emails and decides each one: process (→
 * expense, email to Trash) or ignore (drops off the list). The scan
 * classifies locally (same regex gate as the auto-pipeline) but is NOT
 * limited to rule-matched senders, since the review list is how a first-time
 * sender's receipts surface, and the user can "accept" the sender while
 * processing (adds a user rule so their future receipts auto-import).
 *
 * State lives on EmailProcessLog (the pipeline's decision store, one row per
 * email): the scan upserts rows with outcome `pending-review` (plus the
 * receivedAt/fromDisplay the list renders); process flips to
 * created/partial, ignore to `review-ignored`. The auto-pipeline's
 * seenEmail check skips any logged email, so pending/review-ignored rows
 * are never double-processed by a drain, and emails the pipeline already
 * created or ignored stay out of the list (the scan re-examines only
 * undecided or recoverable rows).
 *
 * Bank transaction notifications ("A new transaction was charged to your
 * account") are special: the same email is noise when the merchant also
 * sends a receipt and the only record when they don't, so the content
 * can't decide. The scan decides them by arrival timing
 * (`decideNotifications`), mirroring the mailbox's view of a charge:
 * alerts land within a minute of the transaction, the receipt email
 * minutes to an hour later. Notifications cluster into bursts (one
 * charge) and pair with receipt emails that arrived shortly AFTER them;
 * a covered burst is logged `review-ignored` with reason
 * `superseded:<expenseId>`. The decisions are recomputed every scan, so
 * notifications drop off once their receipt is imported and return if
 * it is deleted (the skip is visible on the page via
 * `listSupersededItems`, never silent). User-ignored rows stay ignored.
 * Uncovered ones reach the list normally, which is how card-only
 * merchants (self-storage, parking) get their expenses.
 */

/** The scan examines at most this many of the most recent Inbox emails per
 * pass, deliberately bounded: a scan stays short (a handful of fetches)
 * and can't be hammered into downloading a whole backlog. Email older than
 * the most recent 50 isn't offered by review; rule-matched senders are
 * still caught by the auto-drain. */
const SCAN_MAX_EMAILS = 50;

/** Max time one scan request spends before returning partial results
 * (defensive; 50 fetches normally take seconds, and this catches a slow
 * mailbox/network). */
const REVIEW_BUDGET_MS = 45_000;

/** Ignored-row reasons that mean "definitely not a receipt": the scan
 * never re-offers these. Everything else (no rule, not a receipt locally,
 * no receipt content, not extractable locally, errors) is re-examined:
 * those are exactly the emails review exists to recover. */
const IGNORED_SKIP_REASONS = new Set(["self", "bounce", "own confirmation"]);

// --- Sender rules -------------------------------------------------------------

/**
 * The rule pattern to remember for a sender when the user accepts them in
 * review: their domain for real senders (matches subdomains, the seeded
 * rule style), or the exact address for freemail providers (a gmail.com
 * rule would import half the internet's forwarded mail).
 */
export function reviewSenderRulePattern(address: string): string {
  const normalized = address.trim().toLowerCase();
  const domain = normalized.split("@")[1] ?? "";
  return domain && !FREE_MAIL_DOMAINS.has(domain) ? domain : normalized;
}

/** All rules that apply to an account (general + user), for sender-state
 * enrichment of the review list. */
export async function rulesForReview(
  accountId: string,
): Promise<Array<{ sender: string }>> {
  const rows = await db.orm.public.EmailRule.where((r) =>
    or(r.accountId.eq(""), r.accountId.eq(accountId)),
  )
    .select("sender")
    .all();
  return rows;
}

/** Does any rule (general or user) already cover this From address? */
export function senderHasRule(
  rules: Array<{ sender: string }>,
  fromAddress: string,
): boolean {
  return rules.some((r) => ruleSenderMatches(r.sender, fromAddress));
}

// --- The scan -----------------------------------------------------------------

export interface ScanResult {
  /** Emails examined (fetch + classify) this pass. */
  scanned: number;
  /** New emails added to the review list this pass. */
  added: number;
  /** Bank notifications superseded by an already-imported receipt. */
  superseded: number;
  /** Total waiting on the list now. */
  pending: number;
  /** True when the batch was fully examined; false means the time budget
   * hit mid-batch; run the scan again to continue. */
  finished: boolean;
  /** True when the mailbox had at least SCAN_MAX_EMAILS recent emails, so
   * the list may be missing older receipts (the scan is capped by design). */
  atCap: boolean;
}

export interface ScanOptions {
  /** Mailbox operations; defaults to the real JMAP adapter (user token). */
  adapter?: ConnectionMailAdapter;
  extractionDeps?: ConnectionDeps;
  /** Time budget before stopping (default REVIEW_BUDGET_MS). */
  budgetMs?: number;
}

/** The charge's timing, as the mailbox sees it: the transaction posts,
 * the bank's alerts land within a minute (domestic and international
 * together), and the merchant's receipt email follows minutes later,
 * within an hour. Two notification emails closer together than this are
 * one charge's alerts, not two charges. */
const NOTIFICATION_BURST_MS = 5 * 60 * 1000;

/** How long after a charge's alerts its receipt email may arrive and
 * still cover them. Receipts lag the charge by minutes; subscriptions
 * can take longer, so this is generous. A receipt arriving later leaves
 * the notification listed: harmless and visible, never a silent loss. */
const RECEIPT_LAG_MAX_MS = 2 * 60 * 60 * 1000;

/** Clock-skew allowance. A receipt never arrives before its own charge's
 * alerts, so a receipt landing before a burst belongs to an earlier
 * charge and must not cover it. */
const RECEIPT_LAG_MIN_MS = -2 * 60 * 1000;

/** One bank-notification candidate collected by the scan's first pass. */
interface NotificationCandidate {
  summary: ConnectionEmailSummary;
  fromAddress: string;
  /** The charge amount off the Amount line; null when absent. */
  amount: string | null;
}

/** A receipt email's arrival, from its process-log row ("expense:<id>"
 * marks the expense it created; receivedAt is the email's arrival). */
interface ReceiptArrival {
  expenseId: string;
  receivedAt: string;
}

/**
 * Decide every collected bank notification for the scan, charge by
 * charge, using the arrival timing: alerts land within a minute of the
 * transaction, the receipt email minutes to an hour later.
 *
 * Notifications group by (date, charge amount) and cluster into bursts
 * by arrival time (one burst = one charge). A receipt expense covers a
 * burst when its EMAIL arrived within RECEIPT_LAG of the burst, and a
 * receipt only covers the burst nearest BEFORE it (the receipt follows
 * its own charge's alerts). So two same-amount charges ten minutes
 * apart with one receipt: the receipt belongs to the earlier charge and
 * the later charge's notification stays listed, exactly as it should.
 * Expenses with no arrival record (hand-entered, forwarded through the
 * receipts-by-email pipeline, or imported before receipts were stamped)
 * never cover anything: every ambiguity fails toward "stays listed".
 * Expenses created from notifications themselves are their charge's
 * record ("notification-expense:<id>"), never covers.
 */
async function decideNotifications(
  accountId: string,
  connectionId: string,
  input: {
    notifications: NotificationCandidate[];
    onSuperseded: (
      summary: ConnectionEmailSummary,
      fromAddress: string,
      coverExpenseId: string,
    ) => Promise<void>;
    onPending: (
      summary: ConnectionEmailSummary,
      fromAddress: string,
    ) => Promise<void>;
  },
): Promise<void> {
  const { notifications, onSuperseded, onPending } = input;
  if (notifications.length === 0) return;

  // Receipt arrivals (expense:<id> rows) and notification-derived
  // expenses (notification-expense:<id> rows) off this connection's log.
  const markerRows = await db.orm.public.EmailProcessLog.where((l) =>
    and(
      l.connectionId.eq(connectionId),
      or(l.error.like("expense:%"), l.error.like("notification-expense%")),
    ),
  )
    .select("error", "receivedAt")
    .all();
  const markerId = (error: string | null, prefix: string): string | null =>
    error !== null && error.startsWith(prefix)
      ? error.slice(prefix.length).split(";")[0]!.trim()
      : null;
  const receiptArrivals: ReceiptArrival[] = [];
  const notificationExpenseIds = new Set<string>();
  for (const row of markerRows) {
    const receiptId = markerId(row.error, "expense:");
    if (receiptId && row.receivedAt !== null) {
      receiptArrivals.push({
        expenseId: receiptId,
        receivedAt: toIso(row.receivedAt),
      });
    }
    const notificationId = markerId(row.error, "notification-expense:");
    if (notificationId) notificationExpenseIds.add(notificationId);
  }

  // Group by (date, amount): matching is per charge amount.
  const groups = new Map<string, NotificationCandidate[]>();
  for (const notification of notifications) {
    if (notification.amount === null) {
      // No parseable Amount line: never supersede what we can't match.
      await onPending(notification.summary, notification.fromAddress);
      continue;
    }
    const key = `${notification.summary.receivedAt.slice(0, 10)}|${notification.amount}`;
    const group = groups.get(key);
    if (group) group.push(notification);
    else groups.set(key, [notification]);
  }

  for (const [key, group] of groups) {
    const [date, amount] = key.split("|") as [string, string];

    // The receipt emails that can cover this charge: their expenses match
    // amount+date, they arrived on this connection, and they are not
    // notification records. Everything else in the expense table is
    // invisible to this matching on purpose (no arrival = no pairing).
    const matchingExpenseIds = new Set(
      (await findChargeExpenses(accountId, [amount], date))
        .filter((expense) => !notificationExpenseIds.has(expense.id))
        .map((expense) => expense.id),
    );
    const receipts = receiptArrivals
      .filter((r) => matchingExpenseIds.has(r.expenseId))
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

    // Bursts in arrival order.
    group.sort((a, b) =>
      a.summary.receivedAt.localeCompare(b.summary.receivedAt),
    );
    const bursts: Array<{
      notifications: NotificationCandidate[];
      at: number;
      coverExpenseId: string | null;
    }> = [];
    for (const notification of group) {
      const at = Date.parse(notification.summary.receivedAt);
      const current = bursts[bursts.length - 1];
      if (current && at - current.at <= NOTIFICATION_BURST_MS) {
        current.notifications.push(notification);
      } else {
        bursts.push({
          notifications: [notification],
          at,
          coverExpenseId: null,
        });
      }
    }

    // Pair receipts to bursts: each receipt, in arrival order, covers
    // the nearest uncovered burst it FOLLOWS (within the lag window).
    // Receipts arriving before a burst belong to an earlier charge.
    for (const receipt of receipts) {
      const t = Date.parse(receipt.receivedAt);
      let chosen: (typeof bursts)[number] | null = null;
      for (const burst of bursts) {
        if (burst.coverExpenseId !== null) continue;
        const lag = t - burst.at;
        if (lag >= RECEIPT_LAG_MIN_MS && lag <= RECEIPT_LAG_MAX_MS) {
          chosen = burst; // keep scanning: the latest preceding burst wins
        }
      }
      if (chosen) chosen.coverExpenseId = receipt.expenseId;
    }

    for (const burst of bursts) {
      for (const notification of burst.notifications) {
        if (burst.coverExpenseId) {
          await onSuperseded(
            notification.summary,
            notification.fromAddress,
            burst.coverExpenseId,
          );
        } else {
          await onPending(notification.summary, notification.fromAddress);
        }
      }
    }
  }
}

/**
 * Scan a connected inbox for receipt-like emails and add them to the
 * review list (rows with outcome pending-review). One bounded batch: the
 * 50 most recent Inbox emails (newest first) are examined; already-decided
 * rows are skipped without a fetch. Stamps reviewScannedAt so the page
 * knows the list is current. A re-scan re-examines the same 50 (cheap,
 * decided rows skip) and picks up mail that arrived since.
 */
export async function scanConnectionInbox(
  connection: EmailConnectionWithSecret,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const token = decryptSecret(connection.tokenEnc);
  // The scan only reads: nothing moves to Trash until the owner acts on
  // the review list.
  const adapter: ConnectionMailAdapter = options.adapter ?? {
    ...connectionMailAdapter(token),
    moveToTrash: () => Promise.resolve(),
  };
  const extractionDeps = options.extractionDeps ?? realExtractionDeps();
  const deps = connectionInboundDeps(connection.id, adapter, extractionDeps);

  const budgetMs = options.budgetMs ?? REVIEW_BUDGET_MS;
  const started = Date.now();
  let scanned = 0;
  let added = 0;
  let superseded = 0;

  const summaries = await adapter.inboxEmailSummaries({
    limit: SCAN_MAX_EMAILS,
    descending: true,
  });

  // Load existing decisions for the batch in one query.
  const rows = await db.orm.public.EmailProcessLog.where((l) =>
    and(
      l.connectionId.eq(connection.id),
      l.emailId.in(summaries.map((s) => s.id)),
    ),
  )
    .select("emailId", "outcome", "error", "subject", "fromAddress")
    .all();
  const byId = new Map(rows.map((r) => [r.emailId, r]));

  const candidates: ConnectionEmailSummary[] = [];
  for (const summary of summaries) {
    const row = byId.get(summary.id);
    if (row) {
      // Already decided (created/partial/processing/pending-review/
      // review-ignored) or definitively not a receipt → skip.
      if (row.outcome !== "ignored" && row.outcome !== "error") {
        // Exception: a bank transaction notification whose supersede
        // state depends on other expenses, so it is never final. A
        // pending one may become covered by a receipt imported since it
        // was listed; a superseded one may lose its cover (the receipt
        // was deleted) and return to the list. Rows the user ignored by
        // hand stay ignored: that decision is theirs, not a match's.
        const notification = isTransactionNotification(
          row.fromAddress ?? "",
          row.subject ?? "",
        );
        const superseded = (row.error ?? "").startsWith("superseded");
        const recheck =
          notification &&
          (row.outcome === "pending-review" ||
            (row.outcome === "review-ignored" && superseded));
        if (!recheck) continue;
      }
      if (
        row.outcome === "ignored" &&
        IGNORED_SKIP_REASONS.has(row.error ?? "")
      ) {
        continue;
      }
    }
    candidates.push(summary);
  }

  // Upsert a row to outcome pending-review: only when it is still
  // recoverable (no row, or ignored/error/superseded), because a drain
  // that processed the email between our row-read and this write owns
  // the decision; flipping a created/processing row back would re-offer
  // an already-imported receipt and risk a duplicate expense. The create
  // path's P2002 means someone else claimed it meanwhile: skip.
  const upsertPending = async (
    summary: ConnectionEmailSummary,
    fromAddress: string,
  ): Promise<void> => {
    const restored = await db.orm.public.EmailProcessLog.where((l) =>
      and(
        l.connectionId.eq(connection.id),
        l.emailId.eq(summary.id),
        or(
          l.outcome.eq("ignored"),
          l.outcome.eq("error"),
          and(l.outcome.eq("review-ignored"), l.error.like("superseded%")),
        ),
      ),
    ).updateAll({
      outcome: "pending-review",
      matched: false,
      error: null,
      receivedAt: fromIso(summary.receivedAt),
      fromDisplay: summary.from,
      fromAddress,
      subject: summary.subject.slice(0, 500),
    });
    if (restored.length > 0) {
      added += restored.length;
      return;
    }
    try {
      await db.orm.public.EmailProcessLog.create({
        connectionId: connection.id,
        emailId: summary.id,
        fromAddress,
        fromDisplay: summary.from,
        subject: summary.subject.slice(0, 500),
        matched: false,
        outcome: "pending-review",
        receivedAt: fromIso(summary.receivedAt),
        createdAt: fromIso(new Date().toISOString()),
      });
    } catch (err) {
      if (isUniqueViolation(err)) return; // claimed meanwhile; its call
      throw err;
    }
    added++;
  };

  // Upsert a row to review-ignored with reason superseded:<id>. Same
  // claim discipline: never touch a row a drain already decided.
  const upsertSuperseded = async (
    summary: ConnectionEmailSummary,
    fromAddress: string,
    coverExpenseId: string,
  ): Promise<void> => {
    const stilled = await db.orm.public.EmailProcessLog.where((l) =>
      and(
        l.connectionId.eq(connection.id),
        l.emailId.eq(summary.id),
        or(
          l.outcome.eq("pending-review"),
          l.outcome.eq("review-ignored"),
          l.outcome.eq("ignored"),
          l.outcome.eq("error"),
        ),
      ),
    ).updateAll({
      outcome: "review-ignored",
      matched: false,
      error: `superseded:${coverExpenseId}`,
      receivedAt: fromIso(summary.receivedAt),
      fromDisplay: summary.from,
      fromAddress,
      subject: summary.subject.slice(0, 500),
    });
    if (stilled.length > 0) {
      superseded++;
      return;
    }
    try {
      await db.orm.public.EmailProcessLog.create({
        connectionId: connection.id,
        emailId: summary.id,
        fromAddress,
        fromDisplay: summary.from,
        subject: summary.subject.slice(0, 500),
        matched: false,
        outcome: "review-ignored",
        error: `superseded:${coverExpenseId}`,
        receivedAt: fromIso(summary.receivedAt),
        createdAt: fromIso(new Date().toISOString()),
      });
    } catch (err) {
      if (isUniqueViolation(err)) return; // claimed meanwhile; its call
      throw err;
    }
    superseded++;
  };

  // Pass 1: fetch + gate every candidate. Bank notifications are
  // collected for pass 2 (their fate depends on the other notifications
  // of the day, not just on their own content); everything else is
  // listed right away.
  const notificationCandidates: Array<{
    summary: ConnectionEmailSummary;
    fromAddress: string;
    amount: string | null;
  }> = [];

  for (const summary of candidates) {
    if (Date.now() - started > budgetMs) break;
    scanned++;
    const email = await deps.fetchReceivedEmail(summary.id);
    const bodyText = email.text ?? htmlToText(email.html ?? "");
    if (
      !looksLikeReceiptEmail({
        subject: summary.subject,
        bodyText,
      })
    ) {
      continue; // not a receipt: no row, the next scan re-checks
    }
    const fromAddress = extractEmailAddress(summary.from ?? "");
    if (isTransactionNotification(fromAddress, summary.subject)) {
      notificationCandidates.push({
        summary,
        fromAddress,
        amount: notificationChargeAmount(bodyText),
      });
      continue;
    }
    await upsertPending(summary, fromAddress);
  }

  // Pass 2: bank notifications, matched charge by charge. A charge
  // produces a BURST of notification emails (domestic + international
  // arrive together), so one receipt covers a burst, not an email: with
  // two same-amount charges in one day and one receipt, only the first
  // burst is superseded and the second stays on the list (its charge
  // has no other record). Expenses created from notifications
  // themselves don't count as covers: they ARE their charge's record
  // (the Extra Space case; marked "notification-expense:<id>" at
  // process time).
  await decideNotifications(connection.accountId, connection.id, {
    notifications: notificationCandidates,
    onSuperseded: upsertSuperseded,
    onPending: upsertPending,
  });

  // The list is now current through this scan's batch.
  await db.orm.public.EmailConnection.where({ id: connection.id }).update({
    reviewScannedAt: fromIso(new Date().toISOString()),
  });
  const pending = await countPendingReview(connection.id);
  return {
    scanned,
    added,
    /** Bank notifications dropped because an imported receipt already
     * covers the same charge (same amount, same date). */
    superseded,
    pending,
    finished: Date.now() - started <= budgetMs,
    atCap: summaries.length >= SCAN_MAX_EMAILS,
  };
}

// --- Reading the list -----------------------------------------------------------

export interface ReviewItem {
  emailId: string;
  receivedAt: string;
  fromAddress: string;
  fromDisplay: string | null;
  subject: string;
  /** Last processing attempt's error, if the item failed before (the item
   * stays on the list; the message explains why). */
  error: string | null;
}

/** Receipts waiting on the review list, newest first. */
export async function listReviewItems(
  connectionId: string,
): Promise<ReviewItem[]> {
  const rows = await db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connectionId), l.outcome.eq("pending-review")),
  )
    .select(
      "emailId",
      "receivedAt",
      "fromAddress",
      "fromDisplay",
      "subject",
      "error",
    )
    .orderBy((l) => l.receivedAt.desc())
    .all();
  return rows.map((r) => ({
    emailId: r.emailId,
    receivedAt: r.receivedAt === null ? "" : toIso(r.receivedAt),
    fromAddress: r.fromAddress,
    fromDisplay: r.fromDisplay,
    subject: r.subject,
    error: r.error,
  }));
}

/** A superseded bank notification, for the review page's audit trail:
 * what arrived, when, and which receipt replaced it. */
export interface SupersededItem {
  emailId: string;
  receivedAt: string;
  fromDisplay: string | null;
  subject: string;
  /** The receipt expense that covered the charge, when the row knows it. */
  expenseId: string | null;
}

/** Recently superseded bank notifications, newest first. The email itself
 * stays in the Inbox; this list is the visible record of the skip. */
export async function listSupersededItems(
  connectionId: string,
  limit = 10,
): Promise<SupersededItem[]> {
  const rows = await db.orm.public.EmailProcessLog.where((l) =>
    and(
      l.connectionId.eq(connectionId),
      l.outcome.eq("review-ignored"),
      l.error.like("superseded%"),
    ),
  )
    .select("emailId", "receivedAt", "fromDisplay", "subject", "error")
    .orderBy((l) => l.receivedAt.desc())
    .limit(limit)
    .all();
  return rows.map((r) => ({
    emailId: r.emailId,
    receivedAt: r.receivedAt === null ? "" : toIso(r.receivedAt),
    fromDisplay: r.fromDisplay,
    subject: r.subject,
    expenseId: r.error?.startsWith("superseded:")
      ? r.error.slice("superseded:".length)
      : null,
  }));
}

/** How many emails are waiting on the review list. */
async function countPendingReview(connectionId: string): Promise<number> {
  const { count } = await db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connectionId), l.outcome.eq("pending-review")),
  ).aggregate((a) => ({ count: a.count() }));
  return count;
}

// --- Per-item actions -----------------------------------------------------------

/** Remove an email from the list without touching the mailbox (the email
 * stays in the Inbox, where the user might still want it). The
 * review-ignored row also stops the auto-pipeline from ever re-offering
 * it. Returns false when the item wasn't on the list anymore. */
export async function ignoreReviewItem(
  connectionId: string,
  emailId: string,
): Promise<boolean> {
  const updated = await db.orm.public.EmailProcessLog.where((l) =>
    and(
      l.connectionId.eq(connectionId),
      l.emailId.eq(emailId),
      l.outcome.eq("pending-review"),
    ),
  ).updateAll({ outcome: "review-ignored", error: "user ignored" });
  return updated.length > 0;
}

export type ReviewProcessResult =
  | { ok: true; expenseId: string; partial: boolean; missing: string[] }
  | { ok: false; error: string };

/**
 * Process one review-list email as an expense: the same pipeline as
 * auto-import, in review mode (explicit user choice: the model is allowed,
 * the rule gate is off, failures keep the item on the list). On success the
 * email moves to Trash, the owner gets a confirmation in their Inbox, and
 * the item drops off the list. When `acceptSender` is set and the sender
 * has no rule yet, the sender is remembered (a user rule) so their future
 * receipts auto-import.
 */
export async function processReviewItem(input: {
  connection: EmailConnectionWithSecret;
  emailId: string;
  acceptSender: boolean;
  /** Mailbox operations + extraction collaborators; defaults to the real
   * JMAP adapter and render pipeline (tests inject fakes). */
  adapter?: ConnectionMailAdapter;
  extractionDeps?: ConnectionDeps;
}): Promise<ReviewProcessResult> {
  const { connection, emailId, acceptSender } = input;
  const row = await db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connection.id), l.emailId.eq(emailId)),
  )
    .select("receivedAt", "fromAddress", "fromDisplay", "subject")
    .first();
  if (!row) {
    return { ok: false, error: "This email is not on the review list." };
  }

  const token = decryptSecret(connection.tokenEnc);
  const adapter = input.adapter ?? connectionMailAdapter(token);
  const summary: ConnectionEmailSummary = {
    id: emailId,
    receivedAt:
      row.receivedAt === null
        ? new Date().toISOString()
        : toIso(row.receivedAt),
    subject: row.subject,
    from: row.fromDisplay ?? row.fromAddress,
  };

  const outcome = await processConnectionEmail(
    connection,
    summary,
    connectionInboundDeps(
      connection.id,
      adapter,
      input.extractionDeps ?? realExtractionDeps(),
    ),
    {
      moveToTrash: (id) => adapter.moveToTrash(id),
      sendToOwner: (email: OwnerEmail) =>
        sendConnectionEmailToOwner(connection, token, email),
    },
    { review: true },
  );

  switch (outcome.status) {
    case "created":
    case "partial": {
      // Prisma 8 has no atomic increment in the ORM lane; read then bump.
      // A lost update only undercounts a stat, never loses data.
      const current = await db.orm.public.EmailConnection.where({
        id: connection.id,
      })
        .select("processedCount")
        .first();
      await db.orm.public.EmailConnection.where({ id: connection.id }).update({
        processedCount: (current?.processedCount ?? 0) + 1,
      });
      if (acceptSender) {
        const fromAddress = extractEmailAddress(
          row.fromDisplay ?? row.fromAddress,
        );
        const existing = await matchEmailRule(
          connection.accountId,
          fromAddress,
        );
        if (!existing) {
          const pattern = reviewSenderRulePattern(fromAddress);
          const result = await addEmailRule({
            accountId: connection.accountId,
            sender: pattern,
            source: "review",
          });
          console.info("[email-review] remembered sender from review", {
            accountId: connection.accountId,
            sender: result.ok ? result.rule.sender : pattern,
          });
        }
      }
      return {
        ok: true,
        expenseId: outcome.expenseId,
        partial: outcome.status === "partial",
        missing: outcome.status === "partial" ? outcome.missing : [],
      };
    }
    case "ignored":
      return {
        ok: false,
        error: "This email is no longer on the review list.",
      };
    case "error":
      return { ok: false, error: outcome.error };
  }
}

/** Scan wrapper that surfaces scan failures to Sentry (the scan is
 * user-driven; a failure should stay visible rather than vanish). */
export async function scanInboxForReview(
  connection: EmailConnectionWithSecret,
): Promise<ScanResult> {
  try {
    return await scanConnectionInbox(connection);
  } catch (err) {
    captureError("[email-review] inbox scan failed", {
      connectionId: connection.id,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
