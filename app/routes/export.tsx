import { FileDown, FileArchive, ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { readExpenses, readReports } from "~/lib/store.server";
import { formatAmount } from "~/lib/format";
import type { Route } from "./+types/export";

export async function loader(_: Route.LoaderArgs) {
  const [reports, expenses] = await Promise.all([
    readReports(),
    readExpenses(),
  ]);
  const byReport = new Map<string, { count: number; total: number }>();
  for (const e of expenses) {
    if (!e.report) continue;
    const cur = byReport.get(e.report) ?? { count: 0, total: 0 };
    cur.count += 1;
    const amt = Number(e.amount);
    if (Number.isFinite(amt)) cur.total += amt;
    byReport.set(e.report, cur);
  }
  return {
    reports: reports.map((r) => ({
      name: r.name,
      count: byReport.get(r.name)?.count ?? 0,
      total: byReport.get(r.name)?.total ?? 0,
    })),
  };
}

export default function ExportPage({ loaderData }: Route.ComponentProps) {
  const { reports } = loaderData;
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <h1 className="mb-6 text-2xl font-bold">Export</h1>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Reports (PDF)</h2>
        <p className="mb-3 text-sm text-gray-500">
          Each report exports as a PDF grouped by category, with all receipt
          images appended.
        </p>
        {reports.length === 0 ? (
          <p className="text-sm text-gray-400">No reports yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {reports.map((r) => (
              <li
                key={r.name}
                className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-3"
              >
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-sm text-gray-500">
                    {r.count} expense{r.count === 1 ? "" : "s"} ·{" "}
                    {formatAmount(r.total.toFixed(2))}
                  </div>
                </div>
                <a
                  href={`/export/report/${encodeURIComponent(r.name)}.pdf`}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                >
                  <FileDown className="h-4 w-4" /> PDF
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Everything (ZIP)</h2>
        <p className="mb-3 text-sm text-gray-500">
          A ZIP with a CSV of all expenses (date, merchant, amount, category,
          report, description) and every receipt image, named by date and
          report.
        </p>
        <Button asChild>
          <a href="/export/all.zip">
            <FileArchive className="h-4 w-4" /> Download ZIP
          </a>
        </Button>
      </section>
    </main>
  );
}
