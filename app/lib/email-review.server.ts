import { htmlToText } from "~/lib/html-text";
import { looksLikeReceiptEmail } from "~/lib/email-classify";
import { FREE_MAIL_DOMAINS } from "~/lib/email-connection-infer.server";
import { decryptSecret } from "~/lib/token-crypto.server";
import {
  addEmailRule,
  matchEmailRule,
  ruleSenderMatches,
} from "~/lib/db/email-rules";
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
    .select("emailId", "outcome", "error")
    .all();
  const byId = new Map(rows.map((r) => [r.emailId, r]));

  const candidates: ConnectionEmailSummary[] = [];
  for (const summary of summaries) {
    const row = byId.get(summary.id);
    if (row) {
      // Already decided (created/partial/processing/pending-review/
      // review-ignored) or definitively not a receipt → skip.
      if (row.outcome !== "ignored" && row.outcome !== "error") continue;
      if (
        row.outcome === "ignored" &&
        IGNORED_SKIP_REASONS.has(row.error ?? "")
      ) {
        continue;
      }
    }
    candidates.push(summary);
  }

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
    const now = new Date().toISOString();
    // Mark the email as pending-review, but only when it is still
    // recoverable (no row, or ignored/error): a drain that processed it
    // between our row-read and this write owns the decision; flipping a
    // created/processing row back to pending-review would re-offer an
    // already-imported receipt and risk a duplicate expense. The create
    // path's P2002 means someone else claimed it meanwhile: skip.
    const flipped = await db.orm.public.EmailProcessLog.where((l) =>
      and(
        l.connectionId.eq(connection.id),
        l.emailId.eq(summary.id),
        or(l.outcome.eq("ignored"), l.outcome.eq("error")),
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
    if (flipped.length === 0) {
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
          createdAt: fromIso(now),
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          continue; // a drain claimed this email meanwhile; its call
        }
        throw err;
      }
    }
    added++;
  }

  // The list is now current through this scan's batch.
  await db.orm.public.EmailConnection.where({ id: connection.id }).update({
    reviewScannedAt: fromIso(new Date().toISOString()),
  });
  const pending = await countPendingReview(connection.id);
  return {
    scanned,
    added,
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
