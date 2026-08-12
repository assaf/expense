import { hash } from "node:crypto";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BadgeCheck,
  ChevronDown,
  CreditCard,
  ListChecks,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { Link, useFetcher, useNavigate, redirect } from "react-router";
import { ulid } from "ulid";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import { Select } from "~/components/ui/Select";
import { requireUser } from "~/lib/auth.server";
import { formatAmount, formatDate } from "~/lib/format";
import {
  matchStatementRows,
  parseStatementUpload,
} from "~/lib/reconcile.server";
import {
  completeReconciliationRun,
  createReconciliationRun,
  discardReconciliationRun,
  findReconciliationRunByHash,
  listReconciliationRuns,
  readCategories,
  readExpenses,
  readReconciliationRun,
  readReports,
  updateReconciliationDecision,
} from "~/lib/database";
import type {
  MatchCandidate,
  NewExpenseDraft,
  ReconciliationDecision,
  ReconciliationRunRecord,
  RowMatch,
  StatementRow,
} from "~/lib/types";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/reconcile";

/** Statements are text files — a generous cap against paste bombs. */
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
 *  - complete: apply every decision in one transaction — matched expenses
 *    are marked reconciled, "new" drafts become expenses (with a rendered
 *    statement receipt), everything undecided is discarded. Nothing
 *    existing is ever deleted.
 */
export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = formString(form, "intent");

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
            "That file is too large — credit card statements are usually well under 1 MB.",
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
          error: `This statement was already reconciled on ${formatDate(existing.completedAt ?? existing.createdAt)}.`,
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

type LoaderData = Route.ComponentProps["loaderData"];

export default function ReconcilePage({ loaderData }: Route.ComponentProps) {
  const run = loaderData.run;
  return (
    <main id="main-content" className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ListChecks aria-hidden="true" className="h-6 w-6" /> Reconcile
        </h1>
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to
            expenses
          </Link>
        </Button>
      </header>
      {run ? (
        <RunPage run={run} loaderData={loaderData} />
      ) : (
        <Landing loaderData={loaderData} />
      )}
    </main>
  );
}

// --- Landing ---------------------------------------------------------------

function Landing({ loaderData }: { loaderData: LoaderData }) {
  const [file, setFile] = useState<File | null>(null);
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  const uploaded =
    fetcher.data && "run" in fetcher.data && fetcher.data.run
      ? fetcher.data.run
      : null;

  // A successful upload redirects to the run — follow it so the URL stays
  // meaningful (reload keeps the session, unlike a bare /reconcile).
  useEffect(() => {
    if (uploaded)
      void navigate(`/reconcile?run=${uploaded.id}`, { replace: true });
  }, [uploaded, navigate]);

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
        <h2 className="mb-1 font-semibold">Upload a statement</h2>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Download this month's transactions from your credit card website and
          upload them here — CSV, QFX/OFX, QBO, XLSX, or PDF. Expense matches
          every charge against your logged receipts; you review the close
          matches and decide what to keep. Nothing is changed until you finish.
        </p>
        <fetcher.Form
          method="post"
          encType="multipart/form-data"
          className="flex flex-col gap-3"
        >
          <input type="hidden" name="intent" value="upload" />
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
              Statement file
            </span>
            <input
              type="file"
              name="file"
              accept=".csv,.qfx,.ofx,.qbo,.xlsx,.pdf,text/csv,application/pdf"
              onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
              className="block w-full text-sm text-gray-600 dark:text-gray-300 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 dark:bg-gray-700 file:px-3 file:py-2 file:text-sm file:font-medium file:text-gray-700 dark:text-gray-200 hover:file:bg-gray-200 dark:bg-gray-600"
            />
          </label>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!file || busy}>
              {busy ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              ) : (
                <CreditCard aria-hidden="true" className="h-4 w-4" />
              )}
              {busy ? "Reading statement…" : "Match my expenses"}
            </Button>
            {error ? (
              <span
                role="alert"
                className="text-sm text-red-600 dark:text-red-400"
              >
                {error}
              </span>
            ) : null}
          </div>
        </fetcher.Form>
      </section>

      {(() => {
        const inProgress = loaderData.runs.filter((r) => r.status === "draft");
        const previous = loaderData.runs.filter((r) => r.status !== "draft");
        return (
          <>
            {inProgress.length > 0 ? (
              <section>
                <h2 className="mb-2 font-semibold">In progress</h2>
                <ul className="flex flex-col gap-2">
                  {inProgress.map((run) => (
                    <li
                      key={run.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3"
                    >
                      <Link
                        to={`/reconcile?run=${run.id}`}
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 transition-colors hover:text-gray-600 dark:text-gray-300"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {run.fileName}
                          </div>
                          <div className="text-sm text-gray-500 dark:text-gray-400">
                            {run.rowCount} transactions · started{" "}
                            {formatDate(run.createdAt)}
                          </div>
                        </div>
                        <span className="shrink-0 text-sm text-blue-600 dark:text-blue-400">
                          Keep going →
                        </span>
                      </Link>
                      <DiscardRunButton runId={run.id} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {previous.length > 0 ? (
              <section>
                <h2 className="mb-2 font-semibold">Previous reconciliations</h2>
                <ul className="flex flex-col gap-2">
                  {previous.map((run) => (
                    <li key={run.id}>
                      <Link
                        to={`/reconcile?run=${run.id}`}
                        className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 transition-colors hover:border-gray-300 dark:border-gray-600"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {run.fileName}
                          </div>
                          <div className="text-sm text-gray-500 dark:text-gray-400">
                            {formatDate(run.completedAt ?? run.createdAt)}
                            {run.status === "discarded" ? " · discarded" : ""}
                          </div>
                        </div>
                        <div className="shrink-0 text-sm text-gray-500 dark:text-gray-400">
                          {run.status === "completed"
                            ? `${run.matchedCount} reconciled · ${run.createdCount} added`
                            : `${run.rowCount} rows`}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        );
      })()}
    </div>
  );
}

/** Discard an in-progress statement (drafts are listed on the landing so a
 * bad parse or an abandoned upload can be thrown away and re-uploaded). */
function DiscardRunButton({ runId }: { runId: string }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const discard = () => {
    const f = new FormData();
    f.set("intent", "discard");
    f.set("runId", runId);
    void fetcher.submit(f, { method: "post" });
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={discard}
      className="shrink-0 text-gray-500 dark:text-gray-400"
    >
      {busy ? (
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      ) : (
        <X aria-hidden="true" className="h-4 w-4" />
      )}
      Discard
    </Button>
  );
}

// --- Run page --------------------------------------------------------------

function RunPage({
  run,
  loaderData,
}: {
  run: ReconciliationRunRecord;
  loaderData: LoaderData;
}) {
  if (run.status === "completed") {
    return <CompletedSummary run={run} />;
  }
  if (run.status === "discarded") {
    return (
      <p className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 text-gray-500 dark:text-gray-400">
        This reconciliation was discarded — no expenses were changed.{" "}
        <Link
          to="/reconcile"
          className="text-blue-600 dark:text-blue-400 hover:underline"
        >
          Upload a statement
        </Link>
        .
      </p>
    );
  }
  return (
    <DraftReview
      run={run}
      openReports={loaderData.openReports}
      categories={loaderData.categoryNames}
    />
  );
}

function CompletedSummary({ run }: { run: ReconciliationRunRecord }) {
  const completed = run.data.completed;
  const skipped = run.skipped;
  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950 p-6">
        <h2 className="mb-1 flex items-center gap-2 font-semibold text-green-800 dark:text-green-300">
          <BadgeCheck aria-hidden="true" className="h-5 w-5" /> Reconciled
        </h2>
        <p className="text-sm text-green-800 dark:text-green-300/80">
          {run.fileName} ·{" "}
          {completed
            ? `${completed.matched} expenses matched · ${completed.created} added as new expenses`
            : `${run.matchedCount} matched · ${run.createdCount} added`}
        </p>
        {completed && completed.errors.length > 0 ? (
          <ul className="mt-3 flex list-disc flex-col gap-1 pl-4 text-sm text-amber-800 dark:text-amber-300">
            {completed.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        {completed && completed.created > 0 ? (
          <ul className="mt-3 flex list-disc flex-col gap-1 pl-4 text-sm text-green-800 dark:text-green-300">
            {completed.createdExpenseIds.map((id) => (
              <li key={id}>
                <Link
                  to={`/expense/${id}`}
                  className="underline hover:text-green-900"
                >
                  New expense
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {skipped.length > 0 ? <SkippedList skipped={skipped} /> : null}
      </section>
      <div>
        <Button asChild variant="secondary">
          <Link to="/reconcile">
            <Plus aria-hidden="true" className="h-4 w-4" /> Reconcile another
            statement
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** Collapsible list of lines the parser couldn't turn into transactions —
 * the user's judgment call, surfaced instead of silently dropped. */
function SkippedList({
  skipped,
}: {
  skipped: ReconciliationRunRecord["skipped"];
}) {
  const [open, setOpen] = useState(false);
  if (skipped.length === 0) return null;
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:text-gray-100"
      >
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
        {skipped.length} unreadable line{skipped.length === 1 ? "" : "s"} (not
        included)
      </button>
      {open ? (
        <ul className="mt-2 flex max-h-60 flex-col gap-1 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 font-mono text-xs text-gray-600 dark:text-gray-300">
          {skipped.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="shrink-0 text-gray-500 dark:text-gray-400">
                L{s.line}
              </span>
              <span className="min-w-0 truncate">{s.raw}</span>
              <span className="ml-auto shrink-0 text-gray-500 dark:text-gray-400">
                {s.reason}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// --- Draft review ----------------------------------------------------------

/** The user's effective call for a row: an explicit decision wins; a
 * `matched` matcher verdict with no decision keeps the auto match;
 * everything else is discarded at completion. */
function effectiveCall(
  match: RowMatch | undefined,
  decision: ReconciliationDecision | undefined,
):
  | { kind: "match"; expenseId: string }
  | { kind: "new" }
  | { kind: "discard" } {
  if (decision?.kind === "match")
    return { kind: "match", expenseId: decision.expenseId };
  if (decision?.kind === "new") return { kind: "new" };
  if (!decision && match?.status === "matched") {
    return { kind: "match", expenseId: match.expenseId };
  }
  return { kind: "discard" };
}

function DraftReview({
  run,
  openReports,
  categories,
}: {
  run: ReconciliationRunRecord;
  openReports: string[];
  categories: string[];
}) {
  const data = run.data;
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";

  // Rows are stored in file order — show them newest first (dates are
  // YYYY-MM-DD, so lexicographic sort is chronological; ties keep file
  // order). Matches and decisions are keyed by `row.index`, so reordering
  // the display list never misaligns them.
  const rows: { row: StatementRow; match: RowMatch | undefined }[] = useMemo(
    () =>
      [...data.rows]
        .sort((a, b) => b.date.localeCompare(a.date) || a.index - b.index)
        .map((row) => ({ row, match: data.matches[row.index] })),
    [data],
  );

  const autoMatched = rows.filter(
    (r) =>
      effectiveCall(r.match, data.decisions[String(r.row.index)]).kind ===
      "match",
  );
  const newExpenses = rows.filter(
    (r) =>
      effectiveCall(r.match, data.decisions[String(r.row.index)]).kind ===
      "new",
  );
  // Every row without an effective match or new-expense decision will be
  // left out at completion — including auto-matched rows the user dropped.
  const unmatched = rows.filter(
    (r) =>
      effectiveCall(r.match, data.decisions[String(r.row.index)]).kind ===
      "discard",
  );
  const droppedCount = unmatched.length;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">{run.fileName}</div>
            <div
              className="text-sm text-gray-500 dark:text-gray-400"
              role="status"
            >
              {rows.length} transactions ·{" "}
              <span className="text-green-700 dark:text-green-400">
                {autoMatched.length} matched
              </span>
              {" · "}
              <span className="text-amber-700 dark:text-amber-400">
                {rows.length - autoMatched.length - newExpenses.length} to
                review
              </span>
              {newExpenses.length ? ` · ${newExpenses.length} to add` : ""}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmDiscard(true)}
            >
              Discard
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => setConfirmComplete(true)}
            >
              {busy ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              ) : (
                <BadgeCheck aria-hidden="true" className="h-4 w-4" />
              )}
              Complete reconciliation
            </Button>
          </div>
        </div>
        {droppedCount > 0 ? (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            {droppedCount} transaction{droppedCount === 1 ? "" : "s"} without a
            decision will be left out — they are not added as expenses.
          </p>
        ) : null}
      </section>

      {autoMatched.length > 0 ? (
        <section>
          <h2 className="mb-2 flex items-center gap-1.5 font-semibold">
            <BadgeCheck
              aria-hidden="true"
              className="h-4 w-4 text-green-600 dark:text-green-400"
            />{" "}
            Matched automatically
            <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
              ({autoMatched.length})
            </span>
          </h2>
          <ul className="flex flex-col gap-2">
            {autoMatched.map(({ row, match }) => {
              const call = effectiveCall(
                match,
                data.decisions[String(row.index)],
              );
              const expenseId = call.kind === "match" ? call.expenseId : "";
              const matchedCandidate = expenseId
                ? match?.status === "matched"
                  ? match.candidate
                  : match?.status === "review"
                    ? match.candidates.find((c) => c.expenseId === expenseId)
                    : undefined
                : undefined;
              return (
                <li key={row.index}>
                  <MatchedRowCard
                    runId={run.id}
                    row={row}
                    candidate={matchedCandidate}
                    match={match}
                    openReports={openReports}
                    categories={categories}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {unmatched.length > 0 ? (
        <section>
          <h2 className="mb-2 font-semibold">
            Needs your decision{" "}
            <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
              ({unmatched.length})
            </span>
          </h2>
          <ul className="flex flex-col gap-2">
            {unmatched.map(({ row, match }) => (
              <li key={row.index}>
                <ReviewRowCard
                  runId={run.id}
                  row={row}
                  match={match}
                  openReports={openReports}
                  categories={categories}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {newExpenses.length > 0 ? (
        <section>
          <h2 className="mb-2 font-semibold">
            Will be added as new expenses{" "}
            <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
              ({newExpenses.length})
            </span>
          </h2>
          <ul className="flex flex-col gap-2">
            {newExpenses.map(({ row }) => (
              <li key={row.index}>
                <NewExpenseCard runId={run.id} row={row} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {confirmComplete ? (
        <ConfirmDialog
          message={
            droppedCount > 0
              ? `Complete reconciliation? ${droppedCount} transaction${droppedCount === 1 ? " has" : "s have"} no decision and will be left out.`
              : "Complete reconciliation? Everything is matched or queued to be added."
          }
          confirmLabel="Complete"
          tone="primary"
          onConfirm={() => {
            const f = new FormData();
            f.set("intent", "complete");
            f.set("runId", run.id);
            void fetcher.submit(f, { method: "post" });
          }}
          onCancel={() => setConfirmComplete(false)}
          deleting={busy}
        />
      ) : null}
      {confirmDiscard ? (
        <ConfirmDialog
          message="Discard this statement? No expenses will be changed."
          confirmLabel="Discard"
          onConfirm={() => {
            const f = new FormData();
            f.set("intent", "discard");
            f.set("runId", run.id);
            void fetcher.submit(f, { method: "post" });
          }}
          onCancel={() => setConfirmDiscard(false)}
          deleting={busy}
        />
      ) : null}
    </div>
  );
}

/** Shared statement-line display. */
function RowFacts({ row }: { row: StatementRow }) {
  return (
    <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate font-medium">
          {row.description || "(no description)"}
          {row.direction === "refund" ? (
            <span className="ml-2 rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-xs font-medium text-gray-500 dark:text-gray-400">
              refund / credit
            </span>
          ) : null}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {formatDate(row.date)}
        </div>
      </div>
      <span className="shrink-0 font-semibold tabular-nums">
        {formatAmount(row.amount)}
      </span>
    </div>
  );
}

/**
 * The row-decision plumbing shared by every row card: the fetcher posting
 * `intent=update` decisions for one statement row, the common FormData
 * fields (runId, rowIndex, kind + extras), and the open/close state of the
 * inline "add as new expense" draft form.
 */
function useRowDecision(
  runId: string,
  rowIndex: number,
): {
  fetcher: ReturnType<typeof useFetcher>;
  busy: boolean;
  submit: (kind: string, extra?: Record<string, string>) => void;
  drafting: boolean;
  toggleDraft: () => void;
  closeDraft: () => void;
} {
  const fetcher = useFetcher();
  const [drafting, setDrafting] = useState(false);
  const submit = (kind: string, extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.set("intent", "update");
    f.set("runId", runId);
    f.set("rowIndex", String(rowIndex));
    f.set("kind", kind);
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    void fetcher.submit(f, { method: "post" });
  };
  return {
    fetcher,
    busy: fetcher.state !== "idle",
    submit,
    drafting,
    toggleDraft: () => setDrafting((v) => !v),
    closeDraft: () => setDrafting(false),
  };
}

/** The inline "add as new expense" draft form for a row, shown while the
 * card's draft is open. The wrapper class differs per card (the matched
 * card lays the form out inside its flex container). */
function DraftForm({
  decision,
  row,
  openReports,
  categories,
  className,
}: {
  decision: ReturnType<typeof useRowDecision>;
  row: StatementRow;
  openReports: string[];
  categories: string[];
  className: string;
}) {
  if (!decision.drafting) return null;
  return (
    <div className={className}>
      <NewExpenseForm
        decision={decision}
        row={row}
        openReports={openReports}
        categories={categories}
      />
    </div>
  );
}

/** A row the matcher matched automatically (high confidence). The default is
 * to keep the match; the user can drop it (→ discarded) or turn it into a
 * new expense instead. */
function MatchedRowCard({
  runId,
  row,
  candidate,
  match,
  openReports,
  categories,
}: {
  runId: string;
  row: StatementRow;
  candidate: MatchCandidate | undefined;
  match: RowMatch | undefined;
  openReports: string[];
  categories: string[];
}) {
  const decision = useRowDecision(runId, row.index);
  const { busy, submit } = decision;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-green-200 dark:border-green-800 bg-green-50/50 p-3">
      <RowFacts row={row} />
      <div className="flex shrink-0 flex-col items-end gap-1">
        {candidate ? (
          <Link
            to={`/expense/${candidate.expenseId}`}
            className="max-w-56 truncate text-sm font-medium text-green-800 dark:text-green-300 underline-offset-2 hover:underline"
          >
            {candidate.merchant} · {formatDate(candidate.date)} ·{" "}
            {formatAmount(candidate.amount)}
          </Link>
        ) : null}
        <div className="flex items-center gap-2 text-xs">
          {match?.status === "matched" && !candidate ? (
            <span className="text-green-700 dark:text-green-400">Matched</span>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={decision.toggleDraft}
            className="font-medium text-blue-700 dark:text-blue-400 hover:underline disabled:opacity-50"
          >
            Add as new expense
          </button>
          <span aria-hidden="true" className="text-gray-300 dark:text-gray-500">
            ·
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => submit("none")}
            className="text-gray-500 dark:text-gray-400 hover:underline disabled:opacity-50"
          >
            Don't match
          </button>
        </div>
      </div>
      <DraftForm
        decision={decision}
        row={row}
        openReports={openReports}
        categories={categories}
        className="basis-full"
      />
    </div>
  );
}

/** A row in the review / unmatched buckets. The user decides: match it to a
 * candidate expense, add it as a new expense, or leave it (→ discarded). */
function ReviewRowCard({
  runId,
  row,
  match,
  openReports,
  categories,
}: {
  runId: string;
  row: StatementRow;
  match: RowMatch | undefined;
  openReports: string[];
  categories: string[];
}) {
  const decision = useRowDecision(runId, row.index);
  const { busy, submit } = decision;
  const candidates = match?.status === "review" ? match.candidates : [];

  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/50 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <RowFacts row={row} />
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={decision.toggleDraft}
            className="text-sm font-medium text-blue-700 dark:text-blue-400 hover:underline disabled:opacity-50"
          >
            <Plus aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />
            Add as new expense
          </button>
        </div>
      </div>

      {match?.status === "review" && match.reasons.length > 0 ? (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
          {match.reasons.join(" ")}
        </p>
      ) : null}

      {candidates.length > 0 ? (
        <fieldset className="mt-2 flex flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">
            Match to an expense:
          </legend>
          {candidates.map((c) => (
            <label
              key={c.expenseId}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-white dark:hover:bg-gray-800 dark:bg-gray-800"
            >
              <input
                type="radio"
                name={`candidate-${row.index}`}
                disabled={busy}
                checked={false}
                onChange={() => submit("match", { expenseId: c.expenseId })}
                className="accent-blue-600"
              />
              <span className="min-w-0 flex-1 truncate">
                {c.merchant} · {formatDate(c.date)} · {formatAmount(c.amount)}
                {c.exactDate && c.exactAmount ? (
                  <span className="ml-2 rounded bg-green-100 dark:bg-green-900/60 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                    exact
                  </span>
                ) : null}
              </span>
              <Link
                to={`/expense/${c.expenseId}`}
                onClick={(e) => e.stopPropagation()}
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                View
              </Link>
            </label>
          ))}
          <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm text-gray-500 dark:text-gray-400 hover:bg-white dark:hover:bg-gray-800 dark:bg-gray-800">
            <input
              type="radio"
              name={`candidate-${row.index}`}
              disabled={busy}
              checked={false}
              onChange={() => submit("none")}
              className="accent-gray-500"
            />
            None of these — not one of my expenses
          </label>
        </fieldset>
      ) : null}

      <DraftForm
        decision={decision}
        row={row}
        openReports={openReports}
        categories={categories}
        className="mt-2"
      />
    </div>
  );
}

/** A row already queued as a new expense — show the pending draft; the
 * user can remove it (and re-add with different fields). */
function NewExpenseCard({ runId, row }: { runId: string; row: StatementRow }) {
  const { busy, submit } = useRowDecision(runId, row.index);
  return (
    <div className="rounded-xl border border-blue-200 dark:border-gray-600 bg-blue-50/50 dark:bg-blue-900/50 p-3">
      <div className="flex items-center gap-3">
        <RowFacts row={row} />
        <div className="flex shrink-0 items-center gap-2 text-sm">
          <span className="text-blue-700 dark:text-blue-400">
            Will be added
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => submit("none")}
            className="text-gray-500 dark:text-gray-400 hover:underline disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

/** Inline form for adding a statement row as a new expense. Prefilled from
 * the row; report is required (the row must be filed somewhere), category
 * optional. The draft is stored on the run and becomes an expense (with a
 * rendered statement receipt) when the reconciliation completes. */
function NewExpenseForm({
  decision,
  row,
  openReports,
  categories,
}: {
  decision: ReturnType<typeof useRowDecision>;
  row: StatementRow;
  openReports: string[];
  categories: string[];
}) {
  const [merchant, setMerchant] = useState(row.description.slice(0, 100));
  const [date, setDate] = useState(row.date);
  const [report, setReport] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const busy = decision.busy;

  const save = () => {
    if (!report || !merchant.trim() || !date) return;
    decision.submit("new", {
      merchant: merchant.trim(),
      date,
      amount: row.amount,
      report,
      category,
      description: description.trim(),
    });
    decision.closeDraft();
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
      <Field label="Merchant" className="min-w-40 flex-1">
        <Input
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          className="h-9"
        />
      </Field>
      <Field label="Date" className="w-36">
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-9"
        />
      </Field>
      <Field label="Amount" className="w-28">
        <Input value={formatAmount(row.amount)} disabled className="h-9" />
      </Field>
      <Field label="Report (required)" className="min-w-40 flex-1">
        <Select
          value={report}
          onChange={(e) => setReport(e.target.value)}
          className="h-9"
        >
          <option value="">Choose a report…</option>
          {openReports.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Category" className="min-w-36">
        <Select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-9"
        >
          <option value="">—</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Description" className="min-w-48 flex-1">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional note"
          className="h-9"
        />
      </Field>
      <Button
        type="button"
        size="sm"
        onClick={save}
        disabled={busy || !report || !merchant.trim() || !date}
      >
        {busy ? (
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        ) : null}
        Add
      </Button>
    </div>
  );
}
