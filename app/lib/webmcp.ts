/**
 * WebMCP experiment: register the app's read tools with the browser so
 * page-embedded agents can use them (Chrome 149+ origin trial; the API is
 * absent everywhere else and this module is a no-op there).
 *
 * `document.modelContext` is the standard surface the WebMCP explainer
 * (webmachinelearning/webmcp) and Chrome ship behind the origin trial.
 * The tools are the same three read tools the MCP endpoint serves: the
 * names, descriptions, and input schemas come from the shared contract in
 * expense-read-tools.ts, and the data comes from /api/webmcp/* with the
 * browser session. Nothing write-shaped is exposed while this is an
 * experiment.
 */

import { READ_TOOLS, filtersToQuery } from "~/lib/expense-read-tools";

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

/**
 * Idempotent: skips entirely when the browser has no WebMCP API (or the
 * tools are already registered, e.g. after dev-server hot reload).
 */
export async function registerWebMcpTools(): Promise<void> {
  const mc = modelContext();
  if (!mc) return;
  const existing = new Set((await mc.getTools()).map((t) => t.name));
  await Promise.all(
    READ_TOOLS.map((spec) => {
      if (existing.has(spec.name)) return undefined;
      return mc.registerTool({
        name: spec.name,
        description: spec.description,
        ...(spec.inputSchema ? { inputSchema: spec.inputSchema } : {}),
        annotations: { readOnlyHint: true },
        execute: (input, { signal }) =>
          api(
            spec.inputSchema
              ? `/api/webmcp/${spec.resource}?${filtersToQuery(input, spec.inputSchema)}`
              : `/api/webmcp/${spec.resource}`,
            signal,
          ),
      });
    }),
  );
}
