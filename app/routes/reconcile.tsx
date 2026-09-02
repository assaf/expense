import { hash } from "node:crypto";
import { ListChecks } from "lucide-react";
import { redirect } from "react-router";
import { ulid } from "ulid";
import { PageShell } from "~/components/PageShell";
import { Landing } from "~/components/reconcile/reconcile-landing";
import { RunPage } from "~/components/reconcile/reconcile-run";
import { requireUser } from "~/lib/auth.server";
import { requireIntent } from "~/lib/route-helpers.server";
import {
  matchStatementRows,
  parseStatementUpload,
} from "~/lib/reconcile.server";
import { readCategories } from "~/lib/db/categories";
import { readExpenses } from "~/lib/db/expenses";
import {
  completeReconciliationRun,
  createReconciliationRun,
  discardReconciliationRun,
  findReconciliationRunByHash,
  listReconciliationRuns,
  readReconciliationRun,
  updateReconciliationDecision,
} from "~/lib/db/reconcile";
import { readReports } from "~/lib/db/reports";
import type { NewExpenseDraft, ReconciliationDecision } from "~/lib/types";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/reconcile";

/** Statements are text files; a generous cap against paste bombs. */
const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const runId = url.searchParams.get("run");
  const [runs, reports, categories] = await Promise.all([
    listReconciliationRuns(user.accountId),
    readReports(user.accountId),
    readCategories(user.accountId),
  ]);
  const openReports = reports.filter((r) => !r.closed).map((r) => r.name);
  if (runId) {
    const run = await readReconciliationRun(user.accountId, runId);
    if (!run) throw new Response("Not found", { status: 404 });
    return {
      run,
      runs,
      openReports,
      categoryNames: categories.map((c) => c.name),
    };
  }
  return {
    run: null,
    runs,
    openReports,
    categoryNames: categories.map((c) => c.name),
  };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Reconcile — Expense" }];
}

/**
 * Reconcile a credit card statement against logged expenses:
 *  - upload: parse + match (server-side), create a draft run
 *  - update: record the user's decision for one statement row (match an
 *    expense / add as a new expense / none), persisted on the run so the
 *    session survives reloads
 *  - complete: apply every decision in one transaction. Matched expenses
 *    are marked reconciled, "new" drafts become expenses (with a rendered
 *    statement receipt), everything undecided is discarded. Nothing
 *    existing is ever deleted.
 */
export async function action({ request }: Route.ActionArgs) {
  const { user, form, intent } = await requireIntent(request);

  if (intent === "upload") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json(
        { error: "Choose a statement file (CSV, QFX/OFX, QBO, XLSX, or PDF)." },
        { status: 400 },
      );
    }
    if (file.size > MAX_STATEMENT_BYTES) {
      return Response.json(
        {
          error:
            "That file is too large; credit card statements are usually well under 1 MB.",
        },
        { status: 400 },
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileHash = hash("sha256", buffer, "hex");
    // Idempotency: the same bytes are the same statement. An open draft
    // resumes where the user left off; a completed run refuses to re-run.
    const existing = await findReconciliationRunByHash(
      user.accountId,
      fileHash,
    );
    if (existing) {
      if (existing.status === "draft") {
        return redirect(`/reconcile?run=${existing.id}`);
      }
      return Response.json(
        {
          error: "This statement was already reconciled.",
          // The client renders the local date/time (formatDate can't render
          // a full timestamp, and the server must not format local time).
          alreadyReconciledAt: existing.completedAt ?? existing.createdAt,
        },
        { status: 409 },
      );
    }

    let parsed: Awaited<ReturnType<typeof parseStatementUpload>>;
    try {
      parsed = await parseStatementUpload(file.name, buffer);
    } catch (err) {
      return Response.json(
        {
          error: `Couldn't read this file: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 400 },
      );
    }
    if (parsed.rows.length === 0) {
      const skip = parsed.skipped.length
        ? ` (${parsed.skipped.length} unreadable line${parsed.skipped.length === 1 ? "" : "s"}).`
        : ".";
      return Response.json(
        {
          error: `No transactions found in this file${skip} Try the CSV or QFX export from your card's website instead.`,
        },
        { status: 400 },
      );
    }

    const expenses = await readExpenses(user.accountId);
    const matches = matchStatementRows(parsed.rows, expenses);
    const run = await createReconciliationRun(user.accountId, {
      id: ulid(),
      fileName: file.name,
      fileHash: fileHash,
      rows: parsed.rows,
      matches,
      skipped: parsed.skipped,
    });
    return redirect(`/reconcile?run=${run.id}`);
  }

  if (intent === "update") {
    const runId = formString(form, "runId");
    const rowIndex = Number(formString(form, "rowIndex"));
    if (!runId || !Number.isInteger(rowIndex) || rowIndex < 0) {
      return unknownIntent();
    }
    let decision: ReconciliationDecision | null = null;
    const kind = formString(form, "kind");
    if (kind === "match") {
      decision = { kind: "match", expenseId: formString(form, "expenseId") };
    } else if (kind === "new") {
      const draft: NewExpenseDraft = {
        date: formString(form, "date"),
        merchant: formString(form, "merchant"),
        amount: formString(form, "amount"),
        report: formString(form, "report"),
        category: formString(form, "category"),
        description: formString(form, "description"),
      };
      decision = { kind: "new", draft };
    } else if (kind === "none") {
      decision = null;
    } else {
      return unknownIntent();
    }
    const ok = await updateReconciliationDecision(
      user.accountId,
      runId,
      rowIndex,
      decision,
    );
    if (!ok) {
      return Response.json(
        { error: "This reconciliation is no longer open." },
        { status: 409 },
      );
    }
    return null;
  }

  if (intent === "complete") {
    const res = await completeReconciliationRun(
      user.accountId,
      formString(form, "runId"),
      formString(form, "today"),
    );
    if (res.error) {
      return Response.json({ error: res.error }, { status: 409 });
    }
    return redirect(`/reconcile?run=${formString(form, "runId")}`);
  }

  if (intent === "discard") {
    await discardReconciliationRun(user.accountId, formString(form, "runId"));
    return redirect("/reconcile");
  }

  return unknownIntent();
}

export default function ReconcilePage({ loaderData }: Route.ComponentProps) {
  const run = loaderData.run;
  return (
    <PageShell
      maxWidth="max-w-4xl"
      icon={<ListChecks aria-hidden="true" className="h-6 w-6" />}
      title="Reconcile"
    >
      {run ? (
        <RunPage
          run={run}
          openReports={loaderData.openReports}
          categories={loaderData.categoryNames}
        />
      ) : (
        <Landing runs={loaderData.runs} />
      )}
    </PageShell>
  );
}
