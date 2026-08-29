import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  EyeOff,
  Loader2,
  Mail,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Link, useFetcher } from "react-router";
import { Alert } from "~/components/ui/Alert";
import { Button } from "~/components/ui/Button";
import { Card } from "~/components/ui/Card";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Badge } from "~/components/ui/Badge";
import { EmptyState } from "~/components/ui/EmptyState";
import { formatShortDate } from "~/lib/format";

/**
 * Inbox review (/email-review): the list of receipt-like emails found in a
 * connected inbox. Each row shows when the email arrived, the sender, and
 * the subject, with two confirmed actions: Process (create the expense,
 * email to Trash) or Ignore (drops off the list, email stays in the Inbox).
 * Processing a receipt from a sender with no rule offers "remember this
 * sender" (adds a user rule for future auto-import).
 *
 * A freshly connected account auto-scans on first visit; the "Scan again"
 * button re-runs it (resuming after a budget timeout, and catching mail
 * that arrived since).
 */

interface ReviewItemView {
  emailId: string;
  receivedAt: string;
  fromAddress: string;
  fromDisplay: string | null;
  subject: string;
  error: string | null;
  hasRule: boolean;
  rulePattern: string;
  /** The charge amount off a bank notification, when this is one. */
  amount?: string | null;
}

interface SupersededItemView {
  emailId: string;
  receivedAt: string;
  fromDisplay: string | null;
  subject: string;
  expenseId: string | null;
}

interface ReviewInboxProps {
  connectionId: string;
  items: ReviewItemView[];
  superseded: SupersededItemView[];
  /** Pending bank notifications: charges whose only record is the card
   * alert, with no expense yet. */
  uncovered: ReviewItemView[];
  scannedAt: string | null;
}

interface ScanResult {
  ok: boolean;
  result?: {
    scanned: number;
    added: number;
    superseded: number;
    pending: number;
    finished: boolean;
    atCap: boolean;
  };
  error?: string;
}

interface ItemResult {
  ok: boolean;
  error?: string;
  expenseId?: string;
}

function senderLabel(item: ReviewItemView): string {
  return item.fromDisplay || item.fromAddress;
}

export function ReviewInbox({
  connectionId,
  items,
  superseded,
  uncovered,
  scannedAt,
}: ReviewInboxProps) {
  const scanFetcher = useFetcher<ScanResult>();
  const scanning = scanFetcher.state !== "idle";
  const scanData = scanFetcher.data;
  const scanError = scanData && !scanData.ok ? scanData.error : undefined;
  const scanTimedOut =
    scanData?.ok && scanData.result && !scanData.result.finished;
  const scanAtCap = scanData?.ok && scanData.result?.atCap === true;
  const autoScanFired = useRef(false);

  // A freshly connected account (never scanned) walks the inbox right away;
  // fired once per page visit; failures are retried from the alert below.
  useEffect(() => {
    if (scannedAt) return;
    if (autoScanFired.current) return;
    autoScanFired.current = true;
    const form = new FormData();
    form.set("intent", "scan");
    form.set("connectionId", connectionId);
    void scanFetcher.submit(form, { method: "post" });
  }, [scannedAt, connectionId, scanFetcher]);

  const scanAgain = () => {
    const form = new FormData();
    form.set("intent", "scan");
    form.set("connectionId", connectionId);
    void scanFetcher.submit(form, { method: "post" });
  };

  return (
    <div>
      {scanning ? (
        <Card
          role="status"
          className="mb-4 flex items-center gap-2 p-4 text-sm text-gray-600 dark:text-gray-300"
        >
          <Loader2
            aria-hidden="true"
            className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400"
          />
          Scanning your inbox for receipts… this can take a minute for a busy
          mailbox.
        </Card>
      ) : null}

      {scanError ? (
        <Alert bordered className="mb-4 flex flex-col items-start gap-2">
          <span>{scanError}</span>
          <span>
            <Button variant="secondary" size="sm" onClick={scanAgain}>
              <RefreshCw aria-hidden="true" className="h-4 w-4" /> Try again
            </Button>
          </span>
        </Alert>
      ) : null}

      {!scanning && scanTimedOut ? (
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          The scan hit its time budget with a large mailbox —{" "}
          <button
            type="button"
            onClick={scanAgain}
            className="text-blue-600 underline underline-offset-2 dark:text-blue-400"
          >
            scan again to continue
          </button>
          .
        </p>
      ) : null}

      {!scanning && scanAtCap ? (
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          The scan covers your last 90 days of email, up to the 500 most recent;
          older mail isn't included. Forward older receipts to your receipts
          address or add them manually.
        </p>
      ) : null}

      {items.length === 0 && !scanning ? (
        <EmptyState className="flex flex-col items-center gap-3">
          <Mail aria-hidden="true" className="h-8 w-8" />
          {scannedAt ? (
            <>
              <p>
                No receipts waiting. New receipt-like mail is picked up by the
                next scan.
              </p>
              <Button variant="secondary" size="sm" onClick={scanAgain}>
                <RefreshCw aria-hidden="true" className="h-4 w-4" /> Scan again
              </Button>
            </>
          ) : (
            <p>
              Scan the inbox to find every receipt and invoice worth processing.
            </p>
          )}
        </EmptyState>
      ) : null}

      {items.length > 0 ? (
        <>
          <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
            {items.length} receipt
            {items.length === 1 ? "" : "s"} found. Process the ones that are
            expenses; ignore the rest. Each action asks for confirmation first.
          </p>
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.emailId}>
                <ReviewRow connectionId={connectionId} item={item} />
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            <button
              type="button"
              onClick={scanAgain}
              disabled={scanning}
              className="text-blue-600 underline underline-offset-2 disabled:opacity-50 dark:text-blue-400"
            >
              Scan again
            </button>{" "}
            to catch mail that arrived since
            {scannedAt ? ` ${formatShortDate(scannedAt)}` : ""}.
          </p>
        </>
      ) : null}

      {uncovered.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
            Bank charges with no expense ({uncovered.length})
          </h2>
          <p className="mt-1 mb-3 text-sm text-gray-500 dark:text-gray-400">
            These card charges have no receipt yet; the alert email is their
            only record. Process the ones that are expenses, ignore the rest.
            The emails stay in your Inbox either way.
          </p>
          {groupByMonth(uncovered).map(([month, charges]) => (
            <div key={month} className="mb-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                {month}
              </p>
              <ul className="flex flex-col gap-2">
                {charges.map((item) => (
                  <li key={item.emailId}>
                    <ReviewRow
                      connectionId={connectionId}
                      item={item}
                      allowRememberSender={false}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      {superseded.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
            Bank notifications skipped ({superseded.length})
          </h2>
          <p className="mt-1 mb-3 text-sm text-gray-500 dark:text-gray-400">
            Each was covered by an imported receipt for the same amount on the
            same date. The emails stay in your Inbox untouched.
          </p>
          <ul className="flex flex-col gap-1 text-sm text-gray-600 dark:text-gray-300">
            {superseded.map((item) => (
              <li
                key={item.emailId}
                className="flex flex-wrap items-baseline gap-x-2"
              >
                <span className="text-gray-500 dark:text-gray-400">
                  {formatShortDate(item.receivedAt)}
                </span>
                <span>{item.fromDisplay ?? ""}</span>
                <span className="text-gray-500 dark:text-gray-400">
                  {item.subject}
                </span>
                {item.expenseId ? (
                  <Link
                    to={`/expense/${item.expenseId}`}
                    className="text-blue-600 underline underline-offset-2 dark:text-blue-400"
                  >
                    View the receipt that covered it
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Group review items by their month, newest first, for the
 * charges-without-expenses section. */
function groupByMonth(
  items: ReviewItemView[],
): Array<[string, ReviewItemView[]]> {
  const byMonth = new Map<string, ReviewItemView[]>();
  for (const item of items) {
    const month = new Date(item.receivedAt).toLocaleString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const group = byMonth.get(month);
    if (group) group.push(item);
    else byMonth.set(month, [item]);
  }
  return [...byMonth.entries()].sort(([a], [b]) => b.localeCompare(a));
}

function ReviewRow({
  connectionId,
  item,
  allowRememberSender = true,
}: {
  connectionId: string;
  item: ReviewItemView;
  /** Hides the "remember this sender" checkbox: accepting a bank as an
   * auto-import sender would turn every notification into an expense. */
  allowRememberSender?: boolean;
}) {
  const fetcher = useFetcher<ItemResult>();
  const [confirm, setConfirm] = useState<"process" | "ignore" | null>(null);
  const [pending, setPending] = useState<"process" | "ignore" | null>(null);
  const [rememberSender, setRememberSender] = useState(true);
  const busy = fetcher.state !== "idle";
  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const processed = fetcher.data?.ok ? fetcher.data.expenseId : null;

  const run = (intent: "process" | "ignore", acceptSender: boolean) => {
    setPending(intent);
    setConfirm(null);
    const form = new FormData();
    form.set("intent", intent);
    form.set("connectionId", connectionId);
    form.set("emailId", item.emailId);
    if (intent === "process" && acceptSender) form.set("acceptSender", "1");
    void fetcher.submit(form, { method: "post" });
  };

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
              {senderLabel(item)}
            </span>
            {allowRememberSender && !item.hasRule ? (
              <Badge
                tone="purple"
                icon={<Sparkles aria-hidden="true" className="h-3 w-3" />}
              >
                New sender
              </Badge>
            ) : null}
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {formatShortDate(item.receivedAt)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-sm text-gray-900 dark:text-gray-100">
            {item.subject || "(no subject)"}
          </p>
          <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500">
            {item.fromAddress}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {item.amount !== null && item.amount !== undefined ? (
            <span className="text-sm font-semibold tabular-nums font-figures text-gray-900 dark:text-gray-100">
              ${item.amount}
            </span>
          ) : null}
          <div className="flex shrink-0 gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirm("ignore")}
              disabled={busy}
            >
              <EyeOff aria-hidden="true" className="h-4 w-4" /> Ignore
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setRememberSender(!item.hasRule);
                setConfirm("process");
              }}
              disabled={busy}
            >
              <CheckCircle2 aria-hidden="true" className="h-4 w-4" /> Process
            </Button>
          </div>
        </div>
      </div>

      {busy ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
          {pending === "ignore" ? "Ignoring…" : "Processing…"}
        </p>
      ) : null}
      {processed ? (
        <p className="mt-2 text-xs text-green-700 dark:text-green-400">
          Expense added —{" "}
          <a
            href={`/expense/${processed}`}
            className="text-blue-600 underline underline-offset-2 dark:text-blue-400"
          >
            open it
          </a>
          .
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-red-700 dark:text-red-400">{error}</p>
      ) : null}

      {confirm === "ignore" ? (
        <ConfirmDialog
          message="Ignore this email?"
          confirmLabel="Ignore"
          tone="primary"
          onConfirm={() => run("ignore", false)}
          onCancel={() => setConfirm(null)}
          deleting={busy}
        >
          It stays in your inbox; it just won't appear on this list again.
        </ConfirmDialog>
      ) : null}

      {confirm === "process" ? (
        <ConfirmDialog
          message="Turn this email into an expense?"
          confirmLabel="Process"
          tone="primary"
          onConfirm={() => run("process", rememberSender)}
          onCancel={() => setConfirm(null)}
          deleting={busy}
        >
          <p className="mb-2">
            An expense is created from the receipt, and the email moves to Trash
            (recoverable). A confirmation with an edit link lands in your inbox.
          </p>
          {allowRememberSender && !item.hasRule ? (
            <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-gray-50 dark:bg-gray-900 p-2">
              <input
                type="checkbox"
                checked={rememberSender}
                onChange={(e) => setRememberSender(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                <b>Remember {item.rulePattern}</b>: future receipts from this
                sender are imported automatically.
              </span>
            </label>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </Card>
  );
}
