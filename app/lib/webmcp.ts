/**
 * WebMCP experiment: register the app's read tools with the browser so
 * page-embedded agents can use them (Chrome 149+ origin trial; the API is
 * absent everywhere else and this module is a no-op there).
 *
 * `document.modelContext` is the standard surface the WebMCP explainer
 * (webmachinelearning/webmcp) and Chrome ship behind the origin trial.
 * The tools are the same three read tools the MCP endpoint serves, backed
 * by /api/webmcp/* with the browser session; nothing write-shaped is
 * exposed while this is an experiment.
 */

/** Minimal structural types for the (still draft) API surface. */
interface WebMcpModelContext {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
      execute: (input: unknown, options: { signal?: AbortSignal }) => unknown;
    },
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  getTools(): Promise<{ name: string }[]>;
}

function modelContext(): WebMcpModelContext | undefined {
  return (document as Document & { modelContext?: WebMcpModelContext })
    .modelContext;
}

/** Same-origin JSON GET with the browser session; returns the parsed body. */
async function api(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

const EXPENSE_FILTERS = {
  type: "object",
  properties: {
    dateFrom: {
      type: "string",
      description: "Inclusive start date YYYY-MM-DD.",
    },
    dateTo: { type: "string", description: "Inclusive end date YYYY-MM-DD." },
    category: { type: "string", description: "Exact category name." },
    merchant: {
      type: "string",
      description: "Substring match on merchant or stop addresses.",
    },
    report: { type: "string", description: "Exact report name." },
    unreported: {
      type: "boolean",
      description: "Only expenses not in any report.",
    },
    type: { type: "string", enum: ["receipt", "mileage"] },
  },
} as const;

function filtersToQuery(input: unknown): string {
  const params = new URLSearchParams();
  if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>,
    )) {
      if (value !== undefined && value !== null && value !== "") {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          params.set(key, String(value));
        }
      }
    }
  }
  return params.toString();
}

/**
 * Idempotent: skips entirely when the browser has no WebMCP API (or the
 * tools are already registered, e.g. after dev-server hot reload).
 */
export async function registerWebMcpTools(): Promise<void> {
  const mc = modelContext();
  if (!mc) return;
  const existing = new Set((await mc.getTools()).map((t) => t.name));
  const tool = (definition: {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    execute: (
      input: unknown,
      options: { signal?: AbortSignal },
    ) => Promise<unknown>;
  }) => {
    if (!existing.has(definition.name)) {
      return mc.registerTool({
        ...definition,
        annotations: { readOnlyHint: true },
      });
    }
  };

  await Promise.all([
    tool({
      name: "list_expenses",
      description:
        "Query the signed-in user's expenses with optional filters (date range, category, merchant, report, unreported-only, type). Returns newest first; amounts are decimal strings.",
      inputSchema: {
        ...EXPENSE_FILTERS,
        properties: {
          ...EXPENSE_FILTERS.properties,
          limit: {
            type: "number",
            description: "Max rows, 1-500 (default 100).",
          },
        },
      },
      execute: (input, { signal }) =>
        api(`/api/webmcp/expenses?${filtersToQuery(input)}`, signal),
    }),
    tool({
      name: "expense_summary",
      description:
        'Totals for expenses matching the filters: overall count + sum, and per-category breakdown. The answer to "how much did I spend on X?".',
      inputSchema: EXPENSE_FILTERS,
      execute: (input, { signal }) =>
        api(`/api/webmcp/summary?${filtersToQuery(input)}`, signal),
    }),
    tool({
      name: "list_reports",
      description: "All reports with their expense counts and exact totals.",
      execute: (_input, { signal }) => api("/api/webmcp/reports", signal),
    }),
  ]);
}
