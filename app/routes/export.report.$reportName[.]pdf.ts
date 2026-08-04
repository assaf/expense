import { requireUser } from "~/lib/auth.server";
import { readExpenses, readReports } from "~/lib/store.server";
import { buildReportPdf } from "~/lib/report-pdf.server";
import { sanitizeFilenamePart } from "~/lib/validation";
import type { Route } from "./+types/export.report.$reportName[.]pdf";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const reportName = params.reportName;
  const [expenses, reports] = await Promise.all([
    readExpenses(user.accountId),
    readReports(user.accountId),
  ]);
  // Validate the report exists (avoid generating PDFs for arbitrary names).
  if (!reports.some((r) => r.name === reportName)) {
    return new Response("Report not found", { status: 404 });
  }

  const pdf = await buildReportPdf(
    user.accountId,
    reportName,
    expenses,
    reports,
  );

  return new Response(pdf as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${sanitizeFilenamePart(reportName)}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
