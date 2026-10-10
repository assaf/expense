import {
  and,
  type DefaultModelRow,
  type ModelAccessor,
} from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { isUniqueViolation } from "~/lib/db/pg-errors";
import { fromIso, toIso, toIsoOrNull } from "~/lib/db/wire";
import type { Contract } from "../../../prisma/contract.d";

/**
 * The write discipline EmailProcessLog's writers share.
 *
 * Three of them put a row there for an email: the drain's decision log, the
 * drain's claim, and the review scan. All three want the same move, update
 * the row for (connectionId, emailId) when there is one they may touch and
 * insert it when there is not, with a unique violation on the insert meaning
 * another writer got there first. The pair's uniqueness is a plain unique
 * index, which Prisma 8's upsert conflictOn cannot target, so the move is
 * spelled out here once. Which rows the update may take and what a lost race
 * means stay with each caller: those are the caller's semantics.
 */

/** An EmailProcessLog row's columns, minus the identity of the row itself:
 * the (connectionId, emailId) pair a write is about, and the id Postgres
 * assigns. */
type EmailLogValues = Omit<
  DefaultModelRow<Contract, "EmailProcessLog">,
  "id" | "connectionId" | "emailId"
>;

/** One filter expression, the shape `and`/`or` take. */
type EmailLogCondition = Parameters<typeof and>[number];

/** The caller's update half: which existing rows the write may take, and
 * what they become. Left out entirely for an insert-only write (the claim),
 * where any row already there belongs to another writer. */
interface EmailLogUpdate {
  /** Columns the update sets; the ones left out keep their value. */
  patch: Partial<EmailLogValues>;
  /** The rows the patch may take, on top of the (connectionId, emailId)
   * pair. Omitted: any row for the pair (the drain's decision log rewrites
   * whatever is there). */
  updatable?: (
    log: ModelAccessor<Contract, "EmailProcessLog">,
  ) => EmailLogCondition;
}

/** One write against an email's log row. */
interface EmailLogWrite {
  connectionId: string;
  emailId: string;
  /** Omitted by the insert-only write. */
  update?: EmailLogUpdate;
  /** The row to insert when the update matched nothing. Every row carries
   * the sender, subject, and a decision; the nullable columns may be left
   * out. */
  create: Partial<EmailLogValues> &
    Pick<
      EmailLogValues,
      "fromAddress" | "subject" | "matched" | "outcome" | "createdAt"
    >;
  /** What a create that hits the (connectionId, emailId) unique index means.
   * "race": the caller is claiming the pair by insert, so the violation is
   * the answer ("raced") rather than a failure. "throw": the row the update
   * was rewriting has vanished and something re-created it, which is not an
   * outcome any caller handles, so let it out. */
  onUniqueViolation: "race" | "throw";
}

/** "updated": the patch took an existing row. "created": nothing matched and
 * the row was inserted. "raced": the insert lost to another writer. */
type EmailLogWriteResult = "updated" | "created" | "raced";

/** Update the email's log row, else create it. */
export async function writeEmailLogRow(
  write: EmailLogWrite,
): Promise<EmailLogWriteResult> {
  const { connectionId, emailId } = write;
  if (write.update) {
    const { patch, updatable } = write.update;
    const updated = await db.orm.public.EmailProcessLog.where((l) => {
      const pair = and(l.connectionId.eq(connectionId), l.emailId.eq(emailId));
      return updatable ? and(pair, updatable(l)) : pair;
    }).updateAll(patch);
    if (updated.length > 0) return "updated";
  }
  try {
    await db.orm.public.EmailProcessLog.create({
      connectionId,
      emailId,
      ...write.create,
    });
  } catch (err) {
    if (write.onUniqueViolation === "race" && isUniqueViolation(err)) {
      return "raced";
    }
    throw err;
  }
  return "created";
}

/** One log row as the batched read hands it back: what a caller needs to
 * apply its own settled/claim policy, with the timestamp already ISO so no
 * caller has to know the wire codec. */
export interface EmailLogSnapshot {
  emailId: string;
  outcome: string;
  createdAt: string;
}

/** Every log row for a batch of emails, in ONE query. The drain asks about a
 * whole mailbox batch at once; the per-email read it replaced cost a pooled
 * round trip per email before the batch did any work, which Sentry tracked as
 * the `pg-pool.connect` N+1 in EXPENSE-1F. The id list is the caller's query
 * batch, so it is bounded by the same `limit` the mailbox query used. */
export async function readEmailLogSnapshots(
  connectionId: string,
  emailIds: string[],
): Promise<EmailLogSnapshot[]> {
  if (emailIds.length === 0) return [];
  const rows = await db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connectionId), l.emailId.in(emailIds)),
  )
    .select("emailId", "outcome", "createdAt")
    .all();
  return rows.map((row) => ({
    emailId: row.emailId,
    outcome: row.outcome,
    createdAt: toIso(row.createdAt),
  }));
}

/** Every log row a connection wrote since `sinceIso`, oldest first, capped at
 * `limit`. This is the drain's one read per walk: it asks about the whole
 * window the walk is about to cover rather than one mailbox batch at a time,
 * because a walk of N batches used to issue N identical reads of
 * `email_process_log` — Sentry EXPENSE-1J, 99 occurrences of one query shape.
 *
 * The cap is a safety valve, not a limit on the walk: the caller falls back to
 * its per-batch read when the window comes back full, so a mailbox busier than
 * the cap costs the same round trips it costs today and never less coverage.
 * The `(connectionId, createdAt)` index carries the range, so the read is
 * bounded by the window rather than by the table. */
export async function readEmailLogWindow(
  connectionId: string,
  sinceIso: string,
  limit: number,
): Promise<EmailLogSnapshot[]> {
  const rows = await db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connectionId), l.createdAt.gte(fromIso(sinceIso))),
  )
    .select("emailId", "outcome", "createdAt")
    .orderBy((l) => l.createdAt.asc())
    .limit(limit)
    .all();
  return rows.map((row) => ({
    emailId: row.emailId,
    outcome: row.outcome,
    createdAt: toIso(row.createdAt),
  }));
}

/** The arrival time of every log row still sitting on "processing" past the
 * caller's stale cutoff, oldest first, with `null` where a row recorded no
 * arrival at all. A resumed mailbox walk starts where the last completed one
 * began instead of at the lookback floor (Sentry EXPENSE-1J), and these are
 * the rows that can sit behind that start: a claim outlives its worker only
 * when the process was killed, and a killed walk records no resume point.
 * Pointing the walk back at them is what keeps
 * `claimEmailForProcessing`'s takeover reachable — otherwise the email sits in
 * the Inbox forever, invisible to the drain and to /email-review alike, and
 * its receipt is never filed. The policy stays with the caller: it passes the
 * same cutoff the takeover predicate uses, so the two cannot disagree and
 * either strand a claim or steal a live one. */
export async function readStaleClaimArrivals(
  connectionId: string,
  staleCutoffIso: string,
): Promise<Array<string | null>> {
  const rows = await db.orm.public.EmailProcessLog.where((l) =>
    and(
      l.connectionId.eq(connectionId),
      l.outcome.eq("processing"),
      l.createdAt.lt(fromIso(staleCutoffIso)),
    ),
  )
    .select("receivedAt")
    .orderBy((l) => l.receivedAt.asc())
    .all();
  return rows.map((row) => toIsoOrNull(row.receivedAt));
}

/** The decision rows for a batch of emails: what the inbox review scan needs
 * about an email that already has one. Same (connectionId, emailIds) pair as
 * the snapshot read above, a wider projection — the scan shows the outcome's
 * reason and the expense it produced, while the drain only has to know
 * whether the row is settled. Two reads, one owner: a change to how a log row
 * is identified lands here, not in two modules that each query the table. */
export async function readEmailLogDecisions(
  connectionId: string,
  emailIds: string[],
) {
  if (emailIds.length === 0) return [];
  return db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connectionId), l.emailId.in(emailIds)),
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
}

/** Every log row for a connection that produced an expense: the receipt
 * arrivals a charge burst is paired against, and the notification expenses
 * that are a charge's own record and never its cover. */
export async function readExpenseLinkedEmailLogs(connectionId: string) {
  return db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connectionId), l.expenseId.isNotNull()),
  )
    .select("expenseId", "fromAddress", "subject", "receivedAt")
    .all();
}

/** The review list itself: rows still waiting on the user, newest arrival
 * first. `chargeAmount` rides along for the charges-with-no-expense view,
 * which reads the same pending set and groups it into bursts by arrival — so
 * that view's own row order never reaches its output and one query serves
 * both. */
export async function readPendingReviewEmailLogs(connectionId: string) {
  return db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connectionId), l.outcome.eq("pending-review")),
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
    .orderBy((l) => l.receivedAt.desc())
    .all();
}

/** The audit trail under it: the notifications a covering receipt superseded,
 * newest first. The email itself stays in the Inbox. */
export async function readSupersededEmailLogs(
  connectionId: string,
  limit: number,
) {
  return db.orm.public.EmailProcessLog.where((l) =>
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
}

/** How many emails are still waiting on the review list. */
export async function countPendingReviewEmailLogs(connectionId: string) {
  const { count } = await db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connectionId), l.outcome.eq("pending-review")),
  ).aggregate((a) => ({ count: a.count() }));
  return count;
}

/** Take one email off the review list without touching the mailbox: the row
 * becomes `review-ignored`, which is also what stops the auto pipeline from
 * ever re-offering it. False when the row was not on the list anymore (a
 * concurrent drain, or a click that already took it) — the update is
 * conditional on the outcome, so it cannot overwrite someone else's
 * decision. */
export async function ignorePendingReviewEmail(
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

/** One row by email id: the arrival and sender the review click needs before
 * it runs the pipeline. Undefined when there is no row, which is also how a
 * stale click (the email already processed) is answered. */
export async function readOneEmailLog(connectionId: string, emailId: string) {
  return db.orm.public.EmailProcessLog.where((l) =>
    and(l.connectionId.eq(connectionId), l.emailId.eq(emailId)),
  )
    .select("receivedAt", "fromAddress", "fromDisplay", "subject")
    .first();
}
