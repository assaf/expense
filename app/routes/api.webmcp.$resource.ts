import type { Route } from "./+types/api.webmcp.$resource";
import { requireUser } from "~/lib/auth.server";
import { readReportSummaries } from "~/lib/db/reports";
import {
  readExpenseSummary,
  readExpensesPage,
} from "~/lib/expense-read.server";
import { parseExpenseFilters } from "~/lib/expense-read-tools";

/**
 * Read-only JSON mirror of three MCP read tools (list_expenses,
 * expense_summary, list_reports) for the WebMCP experiment: in-page tools
 * registered on the app shell (app/lib/webmcp.ts) fetch this with the
 * browser session, so a browser-side agent gets the same data shapes the
 * MCP endpoint serves, without any OAuth. The tool contract lives in
 * expense-read-tools.ts and the implementations in expense-read.server.ts;
 * this loader and the MCP handlers are both thin adapters over them.
 *
 * GET only, no writes: the experiment surface is deliberately inert.
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const query = new URL(request.url).searchParams;
  switch (params.resource) {
    case "expenses": {
      const limit = Number(query.get("limit") ?? "");
      return Response.json(
        await readExpensesPage(
          user.accountId,
          parseExpenseFilters(query),
          limit,
        ),
      );
    }
    case "summary":
      return Response.json(
        await readExpenseSummary(user.accountId, parseExpenseFilters(query)),
      );
    case "reports":
      return Response.json(await readReportSummaries(user.accountId));
    default:
      throw new Response("Not found", { status: 404 });
  }
}

export function headers(): HeadersInit {
  return { "Cache-Control": "private, no-store" };
}
