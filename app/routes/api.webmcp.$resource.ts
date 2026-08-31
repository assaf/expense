import type { Route } from "./+types/api.webmcp.$resource";
import { requireUser } from "~/lib/auth.server";
import { readExpenses } from "~/lib/db/expenses";
import { readReportSummaries } from "~/lib/db/reports";
import { sortExpenses } from "~/lib/format";
import {
  filterExpenses,
  serializeExpense,
  summarizeExpenses,
  type ExpenseFilters,
} from "~/lib/mcp.server";

/**
 * Read-only JSON mirror of three MCP tools (list_expenses, expense_summary,
 * list_reports) for the WebMCP experiment: in-page tools registered on the
 * app shell (app/lib/webmcp.ts) fetch this with the browser session, so a
 * browser-side agent gets the same data shapes the MCP endpoint serves,
 * without any OAuth. Same filtering and serialization as the MCP tools, by
 * importing their implementations from mcp.server.ts.
 *
 * GET only, no writes: the experiment surface is deliberately inert.
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  switch (params.resource) {
    case "expenses":
    case "summary": {
      const q = url.searchParams;
      const type = q.get("type");
      const filters: ExpenseFilters = {
        dateFrom: q.get("dateFrom") ?? undefined,
        dateTo: q.get("dateTo") ?? undefined,
        category: q.get("category") ?? undefined,
        merchant: q.get("merchant") ?? undefined,
        report: q.get("report") ?? undefined,
        unreported: q.get("unreported") === "true" || undefined,
        type: type === "receipt" || type === "mileage" ? type : undefined,
      };
      const expenses = filterExpenses(
        await readExpenses(user.accountId),
        filters,
      );
      if (params.resource === "summary") {
        return Response.json(summarizeExpenses(expenses));
      }
      const limitParam = Number(q.get("limit") ?? "");
      const limit =
        Number.isInteger(limitParam) && limitParam >= 1 && limitParam <= 500
          ? limitParam
          : 100;
      const limited = sortExpenses(expenses).slice(0, limit);
      return Response.json({
        count: expenses.length,
        returned: limited.length,
        expenses: limited.map(serializeExpense),
      });
    }
    case "reports":
      return Response.json(await readReportSummaries(user.accountId));
    default:
      throw new Response("Not found", { status: 404 });
  }
}

export function headers(): HeadersInit {
  return { "Cache-Control": "private, no-store" };
}
