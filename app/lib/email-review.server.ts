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
import { fromIso, nowWire, toIso } from "~/lib/db/wire";
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
 * a covered burst is logged `review-ignored` with reason "superseded"
 * and expenseId = the covering receipt. The decisions are recomputed
 * every scan, so
 * notifications drop off once their receipt is imported and return if
 * it is deleted (the skip is visible on the page via
 * `listSupersededItems`, never silent). User-ignored rows stay ignored.
 * Uncovered ones reach the list normally, which is how card-only
 * merchants (self-storage, parking) get their expenses.
 */

/** The scan offers Inbox email from the last 90 days, newest first (the
 * same lookback the sender-rule inference uses). Anything older isn't
 * offered by review; rule-matched senders are still caught by the
 * auto-drain. The message count is a safety cap on top of the window
 * (500, like the inference scan); the time budget below is what actually
 * stops a pathological mailbox. */
const SCAN_WINDOW_DAYS = 90;
const SCAN_MAX_EMAILS = 500;

/** Max time one scan request spends before returning partial results
 * (defensive; a few hundred fetches normally take seconds, and this
 * catches a slow mailbox/network). */
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
  /** True when the mailbox had at least SCAN_MAX_EMAILS emails in the
   * 90-day window, so the list may be missing older receipts (the scan is
   * capped by design). */
  atCap: boolean;
}

export interface ScanOptions {
  /** Mailbox operations; defaults to the real JMAP adapter (user token). */
  adapter?: ConnectionMailAdapter;
  extractionDeps?: ConnectionDeps;
  /** Time budget before stopping (default REVIEW_BUDGET_MS). */
  budgetMs?: number;
  /** Wall-clock anchor for the scan window; tests pin it so fixture
   * arrival dates stay inside the window. Defaults to real time. */
  now?: number;
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

/** A receipt email's arrival, from its process-log row: expenseId marks
 * the expense the email created; receivedAt is the email's arrival. */
interface ReceiptArrival {
  expenseId: string;
  receivedAt: string;
}

/** A charge burst: one or more notification emails of the same charge. */
interface ChargeBurst {
  /** The burst's notification rows, in arrival order. */
  charges: Array<{ emailId: string; receivedAt: string }>;
  /** Burst start (earliest notification), ISO. */
  at: string;
  /** The charge amount; null when no Amount line parsed. */
  amount: string | null;
  /** The receipt expense covering this burst, when one arrived in time. */
  coverExpenseId: string | null;
}

/** Rows with an expense this email created, split by whether the email
 * is itself a notification (its expense is the charge's record, never a
 * cover) or a receipt (receivedAt is the EMAIL's arrival moment). */
async function loadReceiptArrivals(connectionId: string): Promise<{
  receiptArrivals: ReceiptArrival[];
  notificationExpenseIds: Set<string>;
}> {
  const expenseRows = await db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connectionId), l.expenseId.isNotNull()),
  )
    .select("expenseId", "fromAddress", "subject", "receivedAt")
    .all();
  const receiptArrivals: ReceiptArrival[] = [];
  const notificationExpenseIds = new Set<string>();
  for (const row of expenseRows) {
    const expenseId = row.expenseId;
    if (expenseId === null) continue;
    if (isTransactionNotification(row.fromAddress ?? "", row.subject ?? "")) {
      notificationExpenseIds.add(expenseId);
      continue;
    }
    if (row.receivedAt !== null) {
      receiptArrivals.push({
        expenseId,
        receivedAt: toIso(row.receivedAt),
      });
    }
  }
  return { receiptArrivals, notificationExpenseIds };
}

/** Pair charge bursts to receipt emails by arrival timing (the model in
 * decideNotifications' docstring): notifications group by (date, amount)
 * and cluster into bursts; each receipt covers the nearest burst it
 * follows, within the lag window. Shared by the scan and the
 * charges-without-expenses view. */
async function pairChargesToReceipts(
  accountId: string,
  receiptArrivals: ReceiptArrival[],
  notificationExpenseIds: Set<string>,
  charges: Array<{
    emailId: string;
    receivedAt: string;
    amount: string | null;
  }>,
): Promise<ChargeBurst[]> {
  const bursts: ChargeBurst[] = [];

  // Group by (date, amount). A null-amount notification can't be matched
  // to any receipt: it becomes its own coverless burst.
  const groups = new Map<string, Array<(typeof charges)[number]>>();
  for (const charge of charges) {
    const key =
      charge.amount === null
        ? `null|${charge.emailId}`
        : `${charge.receivedAt.slice(0, 10)}|${charge.amount}`;
    const group = groups.get(key);
    if (group) group.push(charge);
    else groups.set(key, [charge]);
  }

  for (const [key, group] of groups) {
    if (key.startsWith("null|")) {
      for (const charge of group) {
        bursts.push({
          charges: [{ emailId: charge.emailId, receivedAt: charge.receivedAt }],
          at: charge.receivedAt,
          amount: null,
          coverExpenseId: null,
        });
      }
      continue;
    }
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
    group.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const localBursts: ChargeBurst[] = [];
    for (const charge of group) {
      const at = Date.parse(charge.receivedAt);
      const current = localBursts[localBursts.length - 1];
      if (current && at - Date.parse(current.at) <= NOTIFICATION_BURST_MS) {
        current.charges.push({
          emailId: charge.emailId,
          receivedAt: charge.receivedAt,
        });
      } else {
        localBursts.push({
          charges: [{ emailId: charge.emailId, receivedAt: charge.receivedAt }],
          at: charge.receivedAt,
          amount,
          coverExpenseId: null,
        });
      }
    }

    // Pair receipts to bursts: each receipt, in arrival order, covers
    // the nearest uncovered burst it FOLLOWS (within the lag window).
    // Receipts arriving before a burst belong to an earlier charge.
    for (const receipt of receipts) {
      const t = Date.parse(receipt.receivedAt);
      let chosen: ChargeBurst | null = null;
      for (const burst of localBursts) {
        if (burst.coverExpenseId !== null) continue;
        const lag = t - Date.parse(burst.at);
        if (lag >= RECEIPT_LAG_MIN_MS && lag <= RECEIPT_LAG_MAX_MS) {
          chosen = burst; // keep scanning: the latest preceding burst wins
        }
      }
      if (chosen) chosen.coverExpenseId = receipt.expenseId;
    }

    bursts.push(...localBursts);
  }

  return bursts;
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
 * record (their log row is notification-shaped), never covers.
 */
async function decideNotifications(
  accountId: string,
  connectionId: string,
  input: {
    notifications: NotificationCandidate[];
    onSuperseded: (
      notification: NotificationCandidate,
      coverExpenseId: string,
    ) => Promise<void>;
    onPending: (notification: NotificationCandidate) => Promise<void>;
  },
): Promise<void> {
  const { notifications, onSuperseded, onPending } = input;
  if (notifications.length === 0) return;

  const { receiptArrivals, notificationExpenseIds } =
    await loadReceiptArrivals(connectionId);
  const byEmailId = new Map(
    notifications.map((notification) => [
      notification.summary.id,
      notification,
    ]),
  );
  const bursts = await pairChargesToReceipts(
    accountId,
    receiptArrivals,
    notificationExpenseIds,
    notifications.map((notification) => ({
      emailId: notification.summary.id,
      receivedAt: notification.summary.receivedAt,
      amount: notification.amount,
    })),
  );

  for (const burst of bursts) {
    for (const charge of burst.charges) {
      const notification = byEmailId.get(charge.emailId);
      if (!notification) continue;
      if (burst.coverExpenseId) {
        await onSuperseded(notification, burst.coverExpenseId);
      } else {
        await onPending(notification);
      }
    }
  }
}

/** The email identity fields a review row carries (from a scan summary
 * or straight off an EmailProcessLog row). */
interface ReviewEmailLike {
  emailId: string;
  receivedAt: string;
  fromAddress: string;
  fromDisplay: string | null;
  subject: string;
}

function emailFromSummary(
  summary: ConnectionEmailSummary,
  fromAddress: string,
): ReviewEmailLike {
  return {
    emailId: summary.id,
    receivedAt: summary.receivedAt,
    fromAddress,
    fromDisplay: summary.from,
    subject: summary.subject.slice(0, 500),
  };
}

/** Shared claim discipline for the review upserts: update every
 * recoverable row for the email, else create it. "Recoverable" is the
 * caller's list: a plain outcome, or an outcome matched with a reason
 * (only a superseded review-ignored row may flip back to pending; a
 * row the user ignored by hand stays ignored). Flipping a
 * created/processing row would re-offer an already-imported receipt and
 * risk a duplicate expense; the create path's P2002 means someone else
 * claimed it meanwhile: skip. Returns "raced" in that case so callers
 * don't count the row. */
async function upsertReviewRow(
  connectionId: string,
  email: ReviewEmailLike,
  chargeAmount: string | null,
  recoverable: Array<
    | { outcome: "ignored" | "error" | "pending-review" | "review-ignored" }
    | { outcome: "review-ignored"; reason: string }
  >,
  patch: {
    outcome: "pending-review" | "review-ignored";
    reason: string | null;
    expenseId: string | null;
  },
): Promise<"written" | "raced"> {
  const updated = await db.orm.public.EmailProcessLog.where((l) =>
    and(
      l.connectionId.eq(connectionId),
      l.emailId.eq(email.emailId),
      or(
        ...recoverable.map((match) =>
          "reason" in match
            ? and(l.outcome.eq(match.outcome), l.reason.eq(match.reason))
            : l.outcome.eq(match.outcome),
        ),
      ),
    ),
  ).updateAll({
    outcome: patch.outcome,
    matched: false,
    reason: patch.reason,
    expenseId: patch.expenseId,
    error: null,
    chargeAmount,
    receivedAt: fromIso(email.receivedAt),
    fromDisplay: email.fromDisplay,
    fromAddress: email.fromAddress,
    subject: email.subject.slice(0, 500),
  });
  if (updated.length > 0) return "written";
  try {
    await db.orm.public.EmailProcessLog.create({
      connectionId,
      emailId: email.emailId,
      fromAddress: email.fromAddress,
      fromDisplay: email.fromDisplay,
      subject: email.subject.slice(0, 500),
      matched: false,
      outcome: patch.outcome,
      reason: patch.reason,
      expenseId: patch.expenseId,
      chargeAmount,
      receivedAt: fromIso(email.receivedAt),
      createdAt: nowWire(),
    });
  } catch (err) {
    if (isUniqueViolation(err)) return "raced"; // claimed meanwhile
    throw err;
  }
  return "written";
}

/** Upsert a row to outcome pending-review, carrying the parsed charge
 * amount when the email is a bank notification. Only rows still
 * recoverable flip: ignored, error, or a superseded review-ignored row. */
async function writePendingRow(
  connectionId: string,
  email: ReviewEmailLike,
  chargeAmount: string | null,
): Promise<"written" | "raced"> {
  return upsertReviewRow(
    connectionId,
    email,
    chargeAmount,
    [
      { outcome: "ignored" },
      { outcome: "error" },
      { outcome: "review-ignored", reason: "superseded" },
    ],
    { outcome: "pending-review", reason: null, expenseId: null },
  );
}

/** Upsert a row to review-ignored with reason "superseded" and the
 * covering expense id. Any undecided row flips; a created/processing row
 * is owned by the drain and is left alone. */
async function writeSupersededRow(
  connectionId: string,
  email: ReviewEmailLike,
  chargeAmount: string | null,
  coverExpenseId: string,
): Promise<"written" | "raced"> {
  return upsertReviewRow(
    connectionId,
    email,
    chargeAmount,
    [
      { outcome: "pending-review" },
      { outcome: "review-ignored" },
      { outcome: "ignored" },
      { outcome: "error" },
    ],
    {
      outcome: "review-ignored",
      reason: "superseded",
      expenseId: coverExpenseId,
    },
  );
}

/**
 * Scan a connected inbox for receipt-like emails and add them to the
 * review list (rows with outcome pending-review). One bounded batch:
 * Inbox email from the last 90 days, newest first, at most 500 messages;
 * already-decided rows are skipped without a fetch. Stamps
 * reviewScannedAt so the page knows the list is current. A re-scan
 * re-examines the same batch (cheap, decided rows skip) and picks up
 * mail that arrived since.
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
    afterIso: new Date(
      (options.now ?? started) - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
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
    .select(
      "emailId",
      "outcome",
      "reason",
      "expenseId",
      "error",
      "subject",
      "fromAddress",
    )
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
        const superseded = row.reason === "superseded";
        const recheck =
          notification &&
          (row.outcome === "pending-review" ||
            (row.outcome === "review-ignored" && superseded));
        if (!recheck) continue;
      }
      if (
        row.outcome === "ignored" &&
        IGNORED_SKIP_REASONS.has(row.reason ?? "")
      ) {
        continue;
      }
    }
    candidates.push(summary);
  }

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
    if (
      (await writePendingRow(
        connection.id,
        emailFromSummary(summary, fromAddress),
        null,
      )) === "written"
    ) {
      added++;
    }
  }

  // Pass 2: bank notifications, matched charge by charge. A charge
  // produces a BURST of notification emails (domestic + international
  // arrive together), so one receipt covers a burst, not an email: with
  // two same-amount charges in one day and one receipt, only the first
  // burst is superseded and the second stays on the list (its charge
  // has no other record). Expenses created from notifications
  // themselves don't count as covers: they ARE their charge's record
  // (the Extra Space case; the row is notification-shaped).
  await decideNotifications(connection.accountId, connection.id, {
    notifications: notificationCandidates,
    onSuperseded: async (notification, coverExpenseId) => {
      if (
        (await writeSupersededRow(
          connection.id,
          emailFromSummary(notification.summary, notification.fromAddress),
          notification.amount,
          coverExpenseId,
        )) === "written"
      ) {
        superseded++;
      }
    },
    onPending: async (notification) => {
      if (
        (await writePendingRow(
          connection.id,
          emailFromSummary(notification.summary, notification.fromAddress),
          notification.amount,
        )) === "written"
      ) {
        added++;
      }
    },
  });

  // The list is now current through this scan's batch.
  await db.orm.public.EmailConnection.where({ id: connection.id }).update({
    reviewScannedAt: nowWire(),
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
  /** The receipt expense that covered the charge. */
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
      l.reason.eq("superseded"),
    ),
  )
    .select("emailId", "receivedAt", "fromDisplay", "subject", "expenseId")
    .orderBy((l) => l.receivedAt.desc())
    .limit(limit)
    .all();
  return rows.map((r) => ({
    emailId: r.emailId,
    receivedAt: r.receivedAt === null ? "" : toIso(r.receivedAt),
    fromDisplay: r.fromDisplay,
    subject: r.subject,
    expenseId: r.expenseId,
  }));
}

/** A pending bank notification with no covering receipt: a charge with
 * no expense yet. Rendered on the review page under "Charges with no
 * expense" and actionable like any review item. */
export interface UncoveredCharge {
  emailId: string;
  receivedAt: string;
  fromAddress: string;
  fromDisplay: string | null;
  subject: string;
  /** A processing failure, when the item failed before (surfaced on the
   * review row). */
  error: string | null;
  /** The charge amount off the Amount line, when one parsed. */
  amount: string | null;
}

/**
 * Every pending bank notification for the connection: charges whose only
 * record is the card alert (self-storage, parking). Covered pending
 * notifications are flipped to superseded here, so the list self-cleans
 * as receipts arrive even for emails long past the scan's 90-day
 * window; the rest return as items. This is the charge-side bookend to
 * the superseded audit: nothing is lost silently.
 */
export async function listUncoveredCharges(
  connection: EmailConnectionWithSecret,
): Promise<UncoveredCharge[]> {
  const rows = await db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connection.id), l.outcome.eq("pending-review")),
  )
    .select(
      "emailId",
      "receivedAt",
      "fromAddress",
      "fromDisplay",
      "subject",
      "error",
      "chargeAmount",
    )
    .all();
  const notificationRows = rows.filter(
    (r) =>
      r.receivedAt !== null &&
      isTransactionNotification(r.fromAddress, r.subject),
  );
  if (notificationRows.length === 0) return [];

  const { receiptArrivals, notificationExpenseIds } = await loadReceiptArrivals(
    connection.id,
  );
  const bursts = await pairChargesToReceipts(
    connection.accountId,
    receiptArrivals,
    notificationExpenseIds,
    notificationRows.map((r) => ({
      emailId: r.emailId,
      receivedAt: toIso(r.receivedAt!),
      amount: r.chargeAmount,
    })),
  );

  const uncovered: UncoveredCharge[] = [];
  for (const burst of bursts) {
    for (const charge of burst.charges) {
      const row = notificationRows.find((r) => r.emailId === charge.emailId);
      if (!row) continue;
      if (burst.coverExpenseId !== null) {
        // A receipt arrived for this charge since it was listed: move it
        // to the superseded audit so the feed shows only real gaps.
        await writeSupersededRow(
          connection.id,
          {
            emailId: row.emailId,
            receivedAt: charge.receivedAt,
            fromAddress: row.fromAddress,
            fromDisplay: row.fromDisplay,
            subject: row.subject,
          },
          burst.amount,
          burst.coverExpenseId,
        );
      } else {
        uncovered.push({
          emailId: row.emailId,
          receivedAt: charge.receivedAt,
          fromAddress: row.fromAddress,
          fromDisplay: row.fromDisplay,
          subject: row.subject,
          error: row.error,
          amount: burst.amount,
        });
      }
    }
  }
  return uncovered;
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
  ).updateAll({
    outcome: "review-ignored",
    reason: "user ignored",
    expenseId: null,
    error: null,
  });
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
