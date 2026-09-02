import { useEffect, useRef, useState } from "react";
import { CreditCard, Loader2, X } from "lucide-react";
import { Link, useFetcher, useNavigate } from "react-router";
import { Button } from "~/components/ui/Button";
import { cardSurface, Card } from "~/components/ui/Card";
import {
  consumeCommandRequest,
  useCommandRequest,
} from "~/lib/command-requests";
import { cn } from "~/lib/cn";
import { formatDateTime } from "~/lib/format";
import type { ReconciliationRunRecord } from "~/lib/types";

export function Landing({ runs }: { runs: ReconciliationRunRecord[] }) {
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const busy = fetcher.state !== "idle";

  // Handle a one-shot palette "upload reconcile statement" request that may
  // have arrived before this page mounted; mount-time consume makes it
  // strictly one-shot. Only this kind is consumed; other kinds stay pending
  // for the page that handles them. Only refs are referenced, so `[]` deps
  // are complete.
  useCommandRequest((request) => {
    if (request.kind !== "upload-reconcile") return;
    consumeCommandRequest();
    fileInputRef.current?.click();
  });
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  const uploaded =
    fetcher.data && "run" in fetcher.data && fetcher.data.run
      ? fetcher.data.run
      : null;

  // A successful upload redirects to the run. Follow it so the URL stays
  // meaningful (reload keeps the session, unlike a bare /reconcile).
  useEffect(() => {
    if (uploaded)
      void navigate(`/reconcile?run=${uploaded.id}`, { replace: true });
  }, [uploaded, navigate]);

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        <h2 className="mb-1 font-semibold">Upload a statement</h2>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Download this month's transactions from your credit card website and
          upload them here: CSV, QFX/OFX, QBO, XLSX, or PDF. Expense matches
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
              ref={fileInputRef}
              type="file"
              name="file"
              accept=".csv,.qfx,.ofx,.qbo,.xlsx,.pdf,text/csv,application/pdf"
              onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
              className="block w-full text-sm text-gray-600 dark:text-gray-300 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 dark:file:bg-gray-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-gray-700 dark:file:text-gray-200 hover:file:bg-gray-200 dark:hover:file:bg-gray-500"
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
      </Card>

      {(() => {
        const inProgress = runs.filter((r) => r.status === "draft");
        const previous = runs.filter((r) => r.status !== "draft");
        return (
          <>
            {inProgress.length > 0 ? (
              <section>
                <h2 className="mb-2 font-semibold">In progress</h2>
                <ul className="flex flex-col gap-2">
                  {inProgress.map((run) => (
                    <li
                      key={run.id}
                      className={cn(
                        cardSurface,
                        "flex items-center justify-between gap-3 p-3",
                      )}
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
                            <RunTime iso={run.createdAt} />
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
                        className={cn(
                          cardSurface,
                          "flex items-center justify-between gap-3 p-3 transition-colors hover:border-gray-300 dark:hover:border-gray-600",
                        )}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {run.fileName}
                          </div>
                          <div className="text-sm text-gray-500 dark:text-gray-400">
                            <RunTime iso={run.completedAt ?? run.createdAt} />
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

/** A run timestamp in the viewer's timezone: the ISO string until mount,
 * then the local rendering swaps in via effect. SSR runs UTC, so formatting
 * during render would disagree with hydration (the useToday pattern). */
function RunTime({ iso }: { iso: string }) {
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => setLocal(formatDateTime(iso)), [iso]);
  return <>{local ?? iso}</>;
}
