/**
 * The read-tool contract shared by the MCP server and the WebMCP in-page
 * tools: which read tools exist, their names, descriptions, filter fields,
 * and wire schemas. The MCP server builds its zod input schemas from
 * EXPENSE_FILTER_FIELDS, the WebMCP client builds its JSON schemas from the
 * same fields, and /api/webmcp parses query strings with
 * parseExpenseFilters. Adding a filter field or changing a description
 * here updates every surface at once.
 *
 * Isomorphic by design: imported by the browser bundle (webmcp.ts), so no
 * server-side imports here. New read tools still need a handler in
 * mcp.server.ts and a resource in api.webmcp.$resource.ts; this module
 * keeps their contract identical, not their registration automatic.
 */

/** The shared filter fields of list_expenses / expense_summary. */
export interface ExpenseFilters {
  dateFrom?: string;
  dateTo?: string;
  category?: string;
  merchant?: string;
  report?: string;
  unreported?: boolean;
  type?: "receipt" | "mileage";
}

export interface ExpenseFilterField {
  name: keyof ExpenseFilters & string;
  kind: "string" | "boolean" | "enum";
  /** For kind "enum". */
  values?: [string, ...string[]];
  description?: string;
}

export const EXPENSE_FILTER_FIELDS: ExpenseFilterField[] = [
  {
    name: "dateFrom",
    kind: "string",
    description: "Inclusive start date YYYY-MM-DD.",
  },
  {
    name: "dateTo",
    kind: "string",
    description: "Inclusive end date YYYY-MM-DD.",
  },
  {
    name: "category",
    kind: "string",
    description: "Exact category name (case-insensitive).",
  },
  {
    name: "merchant",
    kind: "string",
    description:
      "Substring match on merchant (receipts) or stop addresses (mileage).",
  },
  { name: "report", kind: "string", description: "Exact report name." },
  {
    name: "unreported",
    kind: "boolean",
    description: "Only expenses not in any report.",
  },
  { name: "type", kind: "enum", values: ["receipt", "mileage"] },
];

/** Parse the shared filters from a URL query (the /api/webmcp transport). */
export function parseExpenseFilters(params: URLSearchParams): ExpenseFilters {
  const filters: ExpenseFilters = {};
  for (const field of EXPENSE_FILTER_FIELDS) {
    const raw = params.get(field.name);
    if (raw === null || raw === "") continue;
    // The kind check tells us which ExpenseFilters key field.name is, but
    // TS can't narrow a union of keys through the loop; the casts mirror it.
    if (field.kind === "boolean") {
      if (raw === "true") filters[field.name as "unreported"] = true;
    } else if (field.kind === "enum") {
      if (field.values?.includes(raw)) {
        filters[field.name as "type"] = raw as "receipt" | "mileage";
      }
    } else {
      filters[field.name as "dateFrom"] = raw;
    }
  }
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
    : new Set(EXPENSE_FILTER_FIELDS.map((f) => f.name));
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

/** JSON Schema for the shared filters, for the WebMCP tool registration. */
export function expenseFilterJsonSchema({
  withLimit = false,
}: { withLimit?: boolean } = {}): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const field of EXPENSE_FILTER_FIELDS) {
    const prop: Record<string, unknown> =
      field.kind === "enum"
        ? { type: "string", enum: field.values }
        : { type: field.kind === "boolean" ? "boolean" : "string" };
    if (field.description) prop.description = field.description;
    properties[field.name] = prop;
  }
  if (withLimit) {
    properties.limit = {
      type: "number",
      description: "Max rows, 1-500 (default 100).",
    };
  }
  return { type: "object", properties };
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
