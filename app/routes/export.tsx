import {
  ArrowLeft,
  FileArchive,
  FileDown,
  Lock,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { requireUser } from "~/lib/auth.server";
import { countLabel, formatAmount } from "~/lib/format";
import {
  addReport,
  readReportSummaries,
  removeReport,
  renameReport,
  setReportClosed,
} from "~/lib/database";
import type { ReportSummary } from "~/lib/database";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/export";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const reports = await readReportSummaries(user.accountId);
  return { reports };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Reports — Expense" }];
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = formString(form, "intent");

  switch (intent) {
    case "addReport": {
      const name = formString(form, "name").trim();
      const result = await addReport(user.accountId, name);
      return Response.json(result.ok ? { ok: true, name } : result);
    }
    case "removeReport":
      await removeReport(user.accountId, formString(form, "name"));
      break;
    case "renameReport": {
      const result = await renameReport(
        user.accountId,
        formString(form, "name"),
        formString(form, "newName"),
      );
      return Response.json(result);
    }
    case "setReportClosed":
      await setReportClosed(
        user.accountId,
        formString(form, "name"),
        formString(form, "closed") === "true",
      );
      break;
    default:
      return unknownIntent();
  }
  return redirect("/export");
}

export default function ExportPage({ loaderData }: Route.ComponentProps) {
  const { reports } = loaderData;
  const closed = reports.filter((r) => r.closed);
  const open = reports.filter((r) => !r.closed);

  return (
    <main id="main-content" className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <FileDown aria-hidden="true" className="h-6 w-6" /> Reports
        </h1>
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to
            expenses
          </Link>
        </Button>
      </header>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Open reports</h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Expenses can still be added or edited. Close a report when you're
          ready to file — it freezes the expenses and you can export a PDF.
        </p>
        <ReportSection reports={open} />
      </section>

      <AddReportForm />

      {closed.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-2 flex items-center gap-1.5 text-lg font-semibold">
            <Lock aria-hidden="true" className="h-4 w-4" /> Closed reports
          </h2>
          <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
            Expenses in closed reports are read-only. You can still export and
            reopen them.
          </p>
          <ReportSection reports={closed} />
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-lg font-semibold">
          Download everything (ZIP)
        </h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Every expense across all reports — all time — as a ZIP containing all
          receipt images and a CSV of every expense.
        </p>
        <Button asChild>
          <a
            href="/export/all.zip"
            data-umami-event="file-download"
            data-umami-event-file="all.zip"
          >
            <FileArchive aria-hidden="true" className="h-4 w-4" /> Download ZIP
          </a>
        </Button>
      </section>
    </main>
  );
}

// --- Report list -----------------------------------------------------------

function ReportSection({ reports }: { reports: ReportSummary[] }) {
  if (reports.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">None.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {reports.map((r) => (
        <ReportRow key={r.name} report={r} />
      ))}
    </ul>
  );
}

function ReportRow({ report }: { report: ReportSummary }) {
  const [editing, setEditing] = useState(false);
  const renameRef = useRef<HTMLButtonElement>(null);
  const toggleFetcher = useFetcher();
  const removeFetcher = useFetcher();
  useEffect(() => {
    if (!editing) renameRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <li className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
        <RenameForm name={report.name} onCancel={() => setEditing(false)} />
      </li>
    );
  }

  const confirmRemove = reportDeleteConfirm(report);

  return (
    <li className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{report.name}</span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
              report.closed
                ? "bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300"
                : "bg-green-100 dark:bg-green-900/60 text-green-700 dark:text-green-400"
            }`}
          >
            {report.closed ? "Closed" : "Open"}
          </span>
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {countLabel(report.count)} · {formatAmount(report.total)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <a
          href={`/export/report/${encodeURIComponent(report.name)}.pdf`}
          data-umami-event="file-download"
          data-umami-event-file={`${report.name}.pdf`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <FileDown aria-hidden="true" className="h-4 w-4" /> PDF
        </a>

        <toggleFetcher.Form method="post" className="contents">
          <input type="hidden" name="intent" value="setReportClosed" />
          <input type="hidden" name="name" value={report.name} />
          <input
            type="hidden"
            name="closed"
            value={report.closed ? "false" : "true"}
          />
          <button
            type="submit"
            className={`rounded-full border px-2 py-0.5 text-xs font-medium transition-colors ${
              report.closed
                ? "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                : "border-green-300 dark:border-green-700 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950"
            }`}
          >
            {report.closed ? "Reopen" : "Close"}
          </button>
        </toggleFetcher.Form>

        <button
          ref={renameRef}
          type="button"
          onClick={() => setEditing(true)}
          className="text-gray-500 dark:text-gray-400 hover:text-ink"
          aria-label={`Rename ${report.name}`}
        >
          <Pencil aria-hidden="true" className="h-4 w-4" />
        </button>

        <removeFetcher.Form
          method="post"
          className="contents"
          onSubmit={(e) => {
            if (confirmRemove && !window.confirm(confirmRemove)) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="intent" value="removeReport" />
          <input type="hidden" name="name" value={report.name} />
          <button
            type="submit"
            className="text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400"
            aria-label={`Delete ${report.name}`}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        </removeFetcher.Form>
      </div>
    </li>
  );
}

// --- Rename form -----------------------------------------------------------

type RenameResult = { ok: boolean; error?: string };

function RenameForm({
  name,
  onCancel,
}: {
  name: string;
  onCancel: () => void;
}) {
  const fetcher = useFetcher<RenameResult>();
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fetcher.data?.error) setError(fetcher.data.error);
    else if (fetcher.data?.ok) setError(null);
  }, [fetcher.data]);

  return (
    <div className="flex w-full flex-col gap-1">
      <fetcher.Form method="post" className="flex w-full items-center gap-2">
        <input type="hidden" name="intent" value="renameReport" />
        <input type="hidden" name="name" value={name} />
        <Input
          type="text"
          name="newName"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          autoFocus
          aria-invalid={error ? true : undefined}
          invalid={!!error}
          className="min-w-0 flex-1 px-2 py-1"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!draft.trim() || draft === name}
        >
          Save
        </Button>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 text-sm text-gray-500 dark:text-gray-400 hover:text-ink"
        >
          Cancel
        </button>
      </fetcher.Form>
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </div>
  );
}

// --- Add report form -------------------------------------------------------

function AddReportForm() {
  const fetcher = useFetcher<{
    ok: boolean;
    name?: string;
    error?: string;
  }>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  useEffect(() => {
    const { data } = fetcher;
    if (!data) return;
    if (data.ok && data.name) {
      setDraft("");
      setError(null);
      setAnnouncement(`Added ${data.name}`);
    } else if (data.error) {
      setError(data.error);
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(null), 3000);
    return () => clearTimeout(timer);
  }, [announcement]);

  return (
    <section className="mb-8">
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <fetcher.Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value="addReport" />
        <Input
          type="text"
          name="name"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          placeholder="New report name"
          aria-invalid={error ? true : undefined}
          invalid={!!error}
          className="flex-1"
        />
        <Button
          type="submit"
          size="md"
          variant="secondary"
          disabled={!draft.trim()}
        >
          <Plus aria-hidden="true" className="h-4 w-4" /> Add
        </Button>
      </fetcher.Form>
      {error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </section>
  );
}

// --- Helpers ---------------------------------------------------------------

function reportDeleteConfirm(report: ReportSummary): string | undefined {
  if (!report.closed && report.count <= 1) return undefined;
  const flags: string[] = [];
  if (report.closed) flags.push("is closed");
  if (report.count > 1) flags.push(`contains ${report.count} expenses`);
  const loss =
    report.count > 0
      ? ` Deleting it also deletes the expense${report.count === 1 ? "" : "s"} and any receipt images.`
      : "";
  return `This report ${flags.join(" and ")}.${loss} Delete it anyway?`;
}
