import { useState } from "react";
import { BadgeCheck, ChevronDown, Plus } from "lucide-react";
import { Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { DraftReview } from "./reconcile-review";
import type { ReconciliationRunRecord } from "~/lib/types";

export function RunPage({
  run,
  openReports,
  categories,
}: {
  run: ReconciliationRunRecord;
  openReports: string[];
  categories: string[];
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
    <DraftReview run={run} openReports={openReports} categories={categories} />
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
