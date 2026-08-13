import { requireUser } from "~/lib/auth.server";
import { readExpenses } from "~/lib/db/expenses";
import { reportExists } from "~/lib/db/reports";
import { readMileageRates } from "~/lib/db/seed";
import { buildReportPdf } from "~/lib/report-pdf.server";
import { sanitizeFilenamePart } from "~/lib/validation";
import type { Route } from "./+types/export.report.$reportName[.]pdf";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const reportName = params.reportName;
  const [expenses, rates] = await Promise.all([
    readExpenses(user.accountId),
    readMileageRates(),
  ]);
  // Validate the report exists (avoid generating PDFs for arbitrary names).
  if (!(await reportExists(user.accountId, reportName))) {
    return new Response("Report not found", { status: 404 });
  }

  const pdf = await buildReportPdf(user.accountId, reportName, expenses, rates);

  return new Response(pdf as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${sanitizeFilenamePart(reportName)}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
