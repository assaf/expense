import { useMemo, useState } from "react";
import { BadgeCheck, Loader2, Plus } from "lucide-react";
import { Link, useFetcher } from "react-router";
import { SelectField } from "~/components/editor/editor-shared";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import { Card } from "~/components/ui/Card";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import { Select } from "~/components/ui/Select";
import { formatAmount, formatDate, todayDate } from "~/lib/format";
import type {
  MatchCandidate,
  ReconciliationDecision,
  ReconciliationRunRecord,
  RowMatch,
  StatementRow,
} from "~/lib/types";

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

export function DraftReview({
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

  // Rows are stored in file order; show them newest first (dates are
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
  // left out at completion, including auto-matched rows the user dropped.
  const unmatched = rows.filter(
    (r) =>
      effectiveCall(r.match, data.decisions[String(r.row.index)]).kind ===
      "discard",
  );
  const droppedCount = unmatched.length;

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-5">
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
            decision will be left out; they are not added as expenses.
          </p>
        ) : null}
      </Card>

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
            // The server runs UTC, so the future-date ceiling must be the
            // client's local today, computed in the browser.
            f.set("today", todayDate());
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
            <Badge
              tone="gray"
              square
              className="ml-2 text-gray-500 dark:text-gray-400"
            >
              refund / credit
            </Badge>
          ) : null}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {formatDate(row.date)}
        </div>
      </div>
      <span className="shrink-0 font-semibold tabular-nums font-figures">
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
    <Card variant="green" className="flex flex-wrap items-center gap-3 p-3">
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
    </Card>
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
    <Card variant="amber" className="p-3">
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
                  <Badge tone="green" square className="ml-2">
                    exact
                  </Badge>
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
            None of these (not one of my expenses)
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
    </Card>
  );
}

/** A row already queued as a new expense. Show the pending draft; the
 * user can remove it (and re-add with different fields). */
function NewExpenseCard({ runId, row }: { runId: string; row: StatementRow }) {
  const { busy, submit } = useRowDecision(runId, row.index);
  return (
    <Card variant="blue" className="p-3">
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
    </Card>
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
    <Card className="flex flex-wrap items-end gap-3 rounded-lg p-3">
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
          max={todayDate()}
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
      <SelectField
        label="Category"
        value={category}
        onChange={setCategory}
        options={categories}
        className="min-w-36"
        selectClassName="h-9"
      />
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
    </Card>
  );
}
