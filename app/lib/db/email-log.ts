import {
  and,
  type DefaultModelRow,
  type ModelAccessor,
} from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { isUniqueViolation } from "~/lib/db/pg-errors";
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
