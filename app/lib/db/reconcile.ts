import { ulid } from "ulid";
import prisma from "~/lib/prisma.server";
import { renameImageToConvention, saveImage } from "~/lib/images.server";
import { renderReceiptImage } from "~/lib/receipt-render.server";
import { validateDateNotFuture } from "~/lib/validation";
import { hasAmount } from "~/lib/completeness";
import { expenseData } from "~/lib/db/expenses";
import type { Prisma } from "prisma/generated";
import type {
  NewExpenseDraft,
  ReceiptExpense,
  ReconciliationDecision,
  ReconciliationRunData,
  ReconciliationRunRecord,
  RowMatch,
  SkippedLine,
  StatementRow,
} from "~/lib/types";

// --- Reconciliation --------------------------------------------------------

/** Everything needed to create a draft reconciliation run. */
interface CreateReconciliationRunInput {
  id: string;
  fileName: string;
  fileHash: string;
  rows: StatementRow[];
  matches: RowMatch[];
  skipped: SkippedLine[];
}

/** Defensively normalize the `data` JSON column (legacy/malformed rows
 * shouldn't crash the reconcile page). */
function runToRecord(row: {
  id: string;
  accountId: string;
  fileName: string;
  fileHash: string;
  status: string;
  rowCount: number;
  matchedCount: number;
  createdCount: number;
  skipped: unknown;
  data: unknown;
  createdAt: string;
  completedAt: string | null;
}): ReconciliationRunRecord {
  const skipped = Array.isArray(row.skipped)
    ? (row.skipped as SkippedLine[])
    : [];
  const data = (row.data ?? {}) as ReconciliationRunData;
  if (!Array.isArray(data.rows)) data.rows = [];
  if (!Array.isArray(data.matches)) data.matches = [];
  if (!data.decisions || typeof data.decisions !== "object") {
    data.decisions = {};
  }
  return {
    id: row.id,
    accountId: row.accountId,
    fileName: row.fileName,
    fileHash: row.fileHash,
    status: row.status as ReconciliationRunRecord["status"],
    rowCount: row.rowCount,
    matchedCount: row.matchedCount,
    createdCount: row.createdCount,
    skipped,
    data,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

/** Store a freshly parsed statement as a draft run. Matching is computed by
 * the caller (reconcile.server.ts) and persisted here so the review UI
 * doesn't recompute — the user's decisions accumulate in `data.decisions`. */
export async function createReconciliationRun(
  accountId: string,
  input: CreateReconciliationRunInput,
): Promise<ReconciliationRunRecord> {
  const data: ReconciliationRunData = {
    rows: input.rows,
    matches: input.matches,
    decisions: {},
  };
  const row = await prisma.reconciliationRun.create({
    data: {
      id: input.id,
      accountId,
      fileName: input.fileName,
      fileHash: input.fileHash,
      status: "draft",
      rowCount: input.rows.length,
      matchedCount: 0,
      createdCount: 0,
      skipped: input.skipped as unknown as Prisma.InputJsonValue,
      data: data as unknown as Prisma.InputJsonValue,
      createdAt: new Date().toISOString(),
    },
  });
  return runToRecord(row);
}

export async function readReconciliationRun(
  accountId: string,
  id: string,
): Promise<ReconciliationRunRecord | undefined> {
  const row = await prisma.reconciliationRun.findFirst({
    where: { id, accountId },
  });
  return row ? runToRecord(row) : undefined;
}

/** The most recent draft or completed run for the same uploaded bytes —
 * the idempotency guard. A completed run means "already reconciled"; a
 * draft means the user can resume where they left off. */
export async function findReconciliationRunByHash(
  accountId: string,
  fileHash: string,
): Promise<ReconciliationRunRecord | undefined> {
  const row = await prisma.reconciliationRun.findFirst({
    where: { accountId, fileHash, status: { in: ["draft", "completed"] } },
    orderBy: { createdAt: "desc" },
  });
  return row ? runToRecord(row) : undefined;
}

/** All runs for the account, newest first (the /reconcile landing page —
 * drafts show as in-progress with a discard control, finished runs as
 * history). Also garbage collects drafts abandoned more than 30 days ago. */
export async function listReconciliationRuns(
  accountId: string,
): Promise<ReconciliationRunRecord[]> {
  const staleCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await prisma.reconciliationRun.deleteMany({
    where: { accountId, status: "draft", createdAt: { lt: staleCutoff } },
  });
  const rows = await prisma.reconciliationRun.findMany({
    where: { accountId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map(runToRecord);
}

/** Record (or clear, with null) the user's decision for one statement row
 * of a draft run. Returns false when the run isn't a draft or isn't the
 * account's. */
export async function updateReconciliationDecision(
  accountId: string,
  runId: string,
  rowIndex: number,
  decision: ReconciliationDecision | null,
): Promise<boolean> {
  const run = await prisma.reconciliationRun.findFirst({
    where: { id: runId, accountId, status: "draft" },
    select: { data: true },
  });
  if (!run) return false;
  const data = run.data as unknown as ReconciliationRunData;
  const key = String(rowIndex);
  if (decision === null) {
    delete data.decisions[key];
  } else {
    data.decisions[key] = decision;
  }
  await prisma.reconciliationRun.updateMany({
    where: { id: runId, accountId, status: "draft" },
    data: { data: data as unknown as Prisma.InputJsonValue },
  });
  return true;
}

/** Abandon a draft run — the statement is dropped without touching any
 * expense. */
export async function discardReconciliationRun(
  accountId: string,
  runId: string,
): Promise<boolean> {
  const res = await prisma.reconciliationRun.updateMany({
    where: { id: runId, accountId, status: "draft" },
    data: { status: "discarded", completedAt: new Date().toISOString() },
  });
  return res.count > 0;
}

interface CompleteReconciliationResult {
  matched: number;
  created: number;
  errors: string[];
  createdExpenseIds: string[];
}

/**
 * Apply a draft run: mark every matched expense reconciled (and not yet
 * reconciled) and create the "add as new expense" drafts — one transaction,
 * so completion is all-or-nothing. Statement rows the user left undecided
 * are discarded (they were never in the database — nothing existing is
 * ever deleted by reconciliation).
 *
 * New expenses get a rendered statement receipt as their image (the same
 * text→PNG renderer the receipts-by-email pipeline uses), so they are
 * complete rows, not image-less stubs. Rendering happens before the
 * transaction (sharp/resvg have no DB dependency); a render failure aborts
 * the whole completion so the run stays draft.
 */
export async function completeReconciliationRun(
  accountId: string,
  runId: string,
  /** The client's local today (YYYY-MM-DD) — the browser knows its own
   * timezone; the server runs UTC. Used as the future-date ceiling. */
  today?: string,
): Promise<
  | { error: string; result: null }
  | { error: null; result: CompleteReconciliationResult }
> {
  const run = await readReconciliationRun(accountId, runId);
  if (!run)
    return { error: "This reconciliation was not found.", result: null };
  if (run.status !== "draft") {
    return { error: "This reconciliation is already finished.", result: null };
  }

  const data = run.data;
  const now = new Date().toISOString();

  // Resolve every row: an explicit decision wins; a `matched` matcher
  // verdict with no decision keeps the auto match; everything else is
  // discarded at completion.
  const resolutions = new Map<
    number,
    | { kind: "match"; expenseId: string }
    | { kind: "new"; draft: NewExpenseDraft }
  >();
  for (const [i, _row] of data.rows.entries()) {
    const decision = data.decisions[String(i)];
    if (decision?.kind === "match") {
      resolutions.set(i, { kind: "match", expenseId: decision.expenseId });
    } else if (decision?.kind === "new") {
      resolutions.set(i, { kind: "new", draft: decision.draft });
    } else if (!decision && data.matches[i]?.status === "matched") {
      resolutions.set(i, {
        kind: "match",
        expenseId: data.matches[i]!.expenseId,
      });
    }
  }

  // Render the new-expense receipt images up front — the transaction below
  // must not hold a sharp/render pass.
  const images = new Map<
    number,
    { filename: string; mime: string; originalName: string }
  >();
  for (const [i, res] of resolutions) {
    if (res.kind !== "new") continue;
    const draft = res.draft;
    const originalName = `${run.fileName.replace(/\.[^/.]+$/, "")} row ${i + 1}.png`;
    try {
      const text = [
        draft.merchant,
        draft.date,
        draft.category ? `Category: ${draft.category}` : "",
        draft.description ? `Memo: ${draft.description}` : "",
        `Amount: $${draft.amount}`,
        `Reconciled from ${run.fileName}`,
      ]
        .filter(Boolean)
        .join("\n");
      const png = await renderReceiptImage(text, { subject: draft.merchant });
      const saved = await saveImage(accountId, png, "image/png", originalName);
      images.set(i, { ...saved, originalName });
    } catch (err) {
      return {
        error: `Couldn't render the receipt image for row ${i + 1}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        result: null,
      };
    }
  }

  const outcome = await prisma.$transaction(async (tx) => {
    let matched = 0;
    let created = 0;
    const errors: string[] = [];
    const createdExpenseIds: string[] = [];

    for (const [i, res] of resolutions) {
      if (res.kind === "match") {
        // The expense must still exist, belong to this account, and not be
        // reconciled already (updateMany with reconciledAt: null makes the
        // claim atomic — a concurrent completion can't double-mark).
        const updated = await tx.expense.updateMany({
          where: { id: res.expenseId, accountId, reconciledAt: null },
          data: { reconciledAt: now, reconciledInRunId: runId },
        });
        if (updated.count === 1) {
          matched++;
        } else {
          errors.push(
            `Row ${i + 1}: the matched expense is gone or already reconciled — left unmatched.`,
          );
        }
        continue;
      }

      const draft = res.draft;
      const dateError = validateDateNotFuture(draft.date, today);
      if (dateError) {
        errors.push(`Row ${i + 1}: ${dateError}`);
        continue;
      }
      const report = await tx.report.findFirst({
        where: { accountId, name: draft.report, closed: false },
      });
      if (!report) {
        errors.push(
          `Row ${i + 1}: report “${draft.report}” is missing or closed.`,
        );
        continue;
      }
      if (!hasAmount(draft.amount)) {
        errors.push(`Row ${i + 1}: the amount is invalid.`);
        continue;
      }
      const image = images.get(i);
      if (!image) {
        errors.push(`Row ${i + 1}: the receipt image wasn't rendered.`);
        continue;
      }

      const expense: ReceiptExpense = {
        id: ulid(),
        type: "receipt",
        date: draft.date,
        report: draft.report,
        category: draft.category,
        description: draft.description,
        amount: draft.amount,
        merchant: draft.merchant,
        imageFile: image.filename,
        imageMime: image.mime,
        originalName: image.originalName,
        reconciledAt: now,
        createdAt: now,
        updatedAt: now,
      };
      // The statement row IS the record — name the image by convention like
      // any other filed receipt (2026-08-03_<report>_<file>.png).
      expense.imageFile = await renameImageToConvention(
        accountId,
        expense.imageFile,
        draft.date,
        draft.report,
        expense.originalName,
        expense.imageMime,
      );
      await tx.expense.create({
        data: {
          ...expenseData(expense),
          accountId,
          reconciledAt: now,
          reconciledInRunId: runId,
        },
      });
      createdExpenseIds.push(expense.id);
      created++;
    }

    const completedData: ReconciliationRunData = {
      ...data,
      completed: { matched, created, errors, createdExpenseIds },
    };
    await tx.reconciliationRun.update({
      where: { id: runId },
      data: {
        status: "completed",
        completedAt: now,
        matchedCount: matched,
        createdCount: created,
        data: completedData as unknown as Prisma.InputJsonValue,
      },
    });
    return { matched, created, errors, createdExpenseIds };
  });

  return { error: null, result: outcome };
}
