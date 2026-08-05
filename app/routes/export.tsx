import { FileDown, FileArchive } from "lucide-react";
import { Button } from "~/components/ui/Button";
import { PageShell } from "~/components/PageShell";
import { requireUser } from "~/lib/auth.server";
import { readReportSummaries } from "~/lib/store.server";
import type { ReportSummary } from "~/lib/store.server";
import { countLabel, formatAmount } from "~/lib/format";
import type { Route } from "./+types/export";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  // All reports with their exact counts + totals (one query pass).
  const reports = await readReportSummaries(user.accountId);
  return { reports };
}

function ReportList({ reports }: { reports: ReportSummary[] }) {
  if (reports.length === 0) {
    return <p className="text-sm text-gray-400">No reports yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {reports.map((r) => (
        <li
          key={r.name}
          className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-3"
        >
          <div>
            <div className="font-medium">{r.name}</div>
            <div className="text-sm text-gray-500">
              {countLabel(r.count)} · {formatAmount(r.total)}
            </div>
          </div>
          <a
            href={`/export/report/${encodeURIComponent(r.name)}.pdf`}
            data-umami-event="file-download"
            data-umami-event-file={`${r.name}.pdf`}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            <FileDown className="h-4 w-4" /> PDF
          </a>
        </li>
      ))}
    </ul>
  );
}

export default function ExportPage({ loaderData }: Route.ComponentProps) {
  const { reports } = loaderData;
  // Closed reports always get their own section below, so the open reports
  // stay front and center.
  const closed = reports.filter((r) => r.closed);
  const split = closed.length > 0;
  const open = reports.filter((r) => !r.closed);
  const main = split ? open : reports;
  return (
    <PageShell title="Export">
      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Reports (PDF)</h2>
        <p className="mb-3 text-sm text-gray-500">
          Each report exports as a PDF grouped by category, with all receipt
          images appended.
        </p>
        {main.length === 0 ? (
          <p className="text-sm text-gray-400">
            {split ? "No open reports." : "No reports yet."}
          </p>
        ) : (
          <ReportList reports={main} />
        )}
      </section>

      {split ? (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-semibold">Closed reports (PDF)</h2>
          <p className="mb-3 text-sm text-gray-500">
            These reports are closed — they can still be exported.
          </p>
          <ReportList reports={closed} />
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-lg font-semibold">Everything (ZIP)</h2>
        <p className="mb-3 text-sm text-gray-500">
          A ZIP containing every receipt image (named by date and report) plus a
          CSV of all expenses (date, merchant, amount, category, report,
          description).
        </p>
        <Button asChild>
          <a
            href="/export/all.zip"
            data-umami-event="file-download"
            data-umami-event-file="all.zip"
          >
            <FileArchive className="h-4 w-4" /> Download ZIP
          </a>
        </Button>
      </section>
    </PageShell>
  );
}
