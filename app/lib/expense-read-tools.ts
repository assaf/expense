/**
 * The read-tool contract shared by the MCP server and the WebMCP in-page
 * tools: which read tools exist, their names, descriptions, filter
 * schemas, and wire shapes. The zod schemas below are the single source:
 * the MCP server validates with them directly, and the WebMCP client gets
 * its JSON schemas via z.toJSONSchema, so a field added here updates every
 * surface at once.
 *
 * Isomorphic by design: imported by the browser bundle (webmcp.ts), so no
 * server-side imports here. New read tools still need a handler in
 * mcp.server.ts and a resource in api.webmcp.$resource.ts; this module
 * keeps their contract identical, not their registration automatic.
 */

import { z } from "zod";

/** Filters shared by list_expenses and expense_summary. Each field's
 * description doubles as the tool-schema documentation for both surfaces. */
export const expenseFilterSchema = z.object({
  dateFrom: z.string().optional().describe("Inclusive start date YYYY-MM-DD."),
  dateTo: z.string().optional().describe("Inclusive end date YYYY-MM-DD."),
  category: z
    .string()
    .optional()
    .describe("Exact category name (case-insensitive)."),
  merchant: z
    .string()
    .optional()
    .describe(
      "Substring match on merchant (receipts) or stop addresses (mileage).",
    ),
  report: z.string().optional().describe("Exact report name."),
  unreported: z
    .boolean()
    .optional()
    .describe("Only expenses not in any report."),
  type: z.enum(["receipt", "mileage"]).optional(),
});
export type ExpenseFilters = z.infer<typeof expenseFilterSchema>;

/** list_expenses adds the page-size input; 1-500 mirrors the MCP zod and
 * the readExpensesPage clamp. */
export const listExpensesInputSchema = expenseFilterSchema.extend({
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Max rows (default 100)."),
});

/** Parse the shared filters from a URL query (the /api/webmcp transport).
 * Every value arrives as a string, so the decoding is explicit: unknown
 * and empty params are ignored, booleans pass only as bare "true", and
 * the enum is an allowlist. Same semantics on both agent surfaces. */
export function parseExpenseFilters(params: URLSearchParams): ExpenseFilters {
  const filters: ExpenseFilters = {};
  const raw = (key: string): string | undefined => {
    const value = params.get(key);
    return value === null || value === "" ? undefined : value;
  };
  const dateFrom = raw("dateFrom");
  if (dateFrom !== undefined) filters.dateFrom = dateFrom;
  const dateTo = raw("dateTo");
  if (dateTo !== undefined) filters.dateTo = dateTo;
  const category = raw("category");
  if (category !== undefined) filters.category = category;
  const merchant = raw("merchant");
  if (merchant !== undefined) filters.merchant = merchant;
  const report = raw("report");
  if (report !== undefined) filters.report = report;
  const unreported = raw("unreported");
  if (unreported === "true") filters.unreported = true;
  const type = raw("type");
  if (type === "receipt" || type === "mileage") filters.type = type;
  return filters;
}

/** Serialize tool input to a query string (the WebMCP client transport).
 * Only scalar values for keys the tool's schema declares are sent. */
export function filtersToQuery(
  input: unknown,
  schema?: Record<string, unknown>,
): string {
  const allowed = schema
    ? new Set(Object.keys((schema.properties as Record<string, unknown>) ?? {}))
    : new Set(Object.keys(expenseFilterSchema.shape));
  const params = new URLSearchParams();
  if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>,
    )) {
      if (
        allowed.has(key) &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean") &&
        value !== ""
      ) {
        params.set(key, String(value));
      }
    }
  }
  return params.toString();
}

/** JSON Schema for the shared filters, for the WebMCP tool registration.
 * Derived from the zod schemas so the two surfaces cannot drift; $schema
 * and additionalProperties are stripped to keep the registered contract
 * plain and open like it has always been. */
export function expenseFilterJsonSchema({
  withLimit = false,
}: { withLimit?: boolean } = {}): Record<string, unknown> {
  const json = z.toJSONSchema(
    withLimit ? listExpensesInputSchema : expenseFilterSchema,
  ) as Record<string, unknown>;
  delete json.$schema;
  delete json.additionalProperties;
  return json;
}
/** One read tool, described once for both surfaces. */
export interface ReadToolSpec {
  name: string;
  description: string;
  /** The /api/webmcp resource that mirrors this tool over the session. */
  resource: "expenses" | "summary" | "reports";
  /** JSON Schema for the in-page registration; undefined for no-arg tools. */
  inputSchema?: Record<string, unknown>;
}

export const READ_TOOLS: ReadToolSpec[] = [
  {
    name: "list_expenses",
    resource: "expenses",
    description:
      "Query expenses with optional filters (date range, category, merchant, report, unreported-only, type). Returns newest first. Amounts are decimal strings.",
    inputSchema: expenseFilterJsonSchema({ withLimit: true }),
  },
  {
    name: "expense_summary",
    resource: "summary",
    description:
      'Totals for expenses matching the filters: overall count + sum, and per-category breakdown. The answer to "how much did I spend on X?".',
    inputSchema: expenseFilterJsonSchema(),
  },
  {
    name: "list_reports",
    resource: "reports",
    description: "All reports with their expense counts and exact totals.",
  },
];
