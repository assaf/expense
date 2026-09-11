import { z } from "zod";
import type { ToolSpec } from "~/lib/receipt-ai.server";

/**
 * The one read tool the insights answer step may call: an ad-hoc query over
 * the expenses the request already loaded. Fields mirror the shared
 * read-tool contract (app/lib/expense-read-tools.ts) that MCP `list_expenses`
 * and the WebMCP mirror expose, so the surfaces can't drift in what they can
 * ask for. Read-only and in-memory: no DB round trip, no writes, and the
 * result is capped so a single call can't blow up the prompt.
 */

/** Rounds of tool calls allowed before the model must answer. */
export const MAX_TOOL_ROUNDS = 3;
/** Rows returned per call (newest first) plus the totals that summarize all
 * matches, so a broad query still answers "how much" without dumping the
 * whole account into the prompt. */
export const MAX_TOOL_ROWS = 50;

/** Longest tool-argument JSON the query tool will parse. Real filters are a
 * few hundred bytes; the cap bounds hostile provider output. */
const MAX_TOOL_ARGUMENTS = 4_096;

/** The fields the tool reads. Structural, so the route's already-mapped
 * expenses and plain test fixtures both fit. */
export interface FilterableExpense {
  id: string;
  date: string;
  amount: string | number;
  type?: string;
  merchant?: string;
  category?: string;
  report?: string;
  description?: string;
}

const queryExpensesInput = z.object({
  dateFrom: z.string().optional().describe("Inclusive start date YYYY-MM-DD."),
  dateTo: z.string().optional().describe("Inclusive end date YYYY-MM-DD."),
  categories: z
    .array(z.string().max(200))
    .max(32)
    .optional()
    .describe("Zero or more exact tax category names."),
  merchant: z
    .string()
    .optional()
    .describe("Case-insensitive substring match on the merchant name."),
  report: z.string().optional().describe("Exact report name."),
  unreported: z.boolean().optional().describe("Only expenses in no report."),
  type: z
    .enum(["receipt", "mileage"])
    .optional()
    .describe("Receipt or mileage rows only."),
});

export type QueryExpensesInput = z.infer<typeof queryExpensesInput>;

export const QUERY_EXPENSES = "query_expenses";

export function queryExpensesTool(): ToolSpec {
  return {
    type: "function",
    function: {
      name: QUERY_EXPENSES,
      description:
        "Query this account's expenses. Returns matching rows (newest first, capped) plus the count and total for ALL matches. Use it for any date-ranged or filtered question (a day, a week, a month, a category, a report, a merchant).",
      parameters: z.toJSONSchema(queryExpensesInput),
    },
  };
}

function amountOf(e: FilterableExpense): number {
  const n = Number(e.amount);
  return Number.isFinite(n) ? n : 0;
}

/** Apply the filters (all optional, ANDed) newest-first. Pure. */
export function filterExpenses<T extends FilterableExpense>(
  expenses: readonly T[],
  filters: QueryExpensesInput,
): T[] {
  const merchant = filters.merchant?.toLowerCase();
  const categories = filters.categories?.map((c) => c.toLowerCase());
  return expenses
    .filter((e) => {
      if (filters.dateFrom && e.date < filters.dateFrom) return false;
      if (filters.dateTo && e.date > filters.dateTo) return false;
      if (filters.type && e.type !== filters.type) return false;
      if (filters.report && (e.report ?? "") !== filters.report) return false;
      if (filters.unreported && (e.report ?? "") !== "") return false;
      if (categories && categories.length > 0) {
        const category = (e.category ?? "").toLowerCase();
        if (!categories.includes(category)) return false;
      }
      if (merchant && !(e.merchant ?? "").toLowerCase().includes(merchant)) {
        return false;
      }
      return true;
    })
    .toSorted((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Run one tool call and return its JSON payload (what the model sees). */
export function runQueryExpenses(
  expenses: readonly FilterableExpense[],
  call: { function: { arguments: string } },
): string {
  let args: unknown;
  // The provider is untrusted: a multi-megabyte argument string would be
  // parsed and scanned on the request path before any filter runs.
  if (call.function.arguments.length > MAX_TOOL_ARGUMENTS) {
    return JSON.stringify({ error: "arguments were too long" });
  }
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return JSON.stringify({ error: "arguments were not valid JSON" });
  }
  const parsed = queryExpensesInput.safeParse(args);
  if (!parsed.success) {
    return JSON.stringify({
      error: "invalid filters",
      issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
    });
  }
  const matched = filterExpenses(expenses, parsed.data);
  const total = matched.reduce((sum, e) => sum + amountOf(e), 0);
  return JSON.stringify({
    count: matched.length,
    total: total.toFixed(2),
    rows: matched.slice(0, MAX_TOOL_ROWS).map((e) => ({
      date: e.date,
      type: e.type ?? "receipt",
      merchant: e.merchant ?? "",
      category: e.category ?? "",
      report: e.report ?? "",
      amount: amountOf(e).toFixed(2),
    })),
    truncated: matched.length > MAX_TOOL_ROWS,
  });
}
