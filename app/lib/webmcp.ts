/**
 * WebMCP experiment: register the app's read tools with the browser so
 * page-embedded agents can use them (Chrome 149+ origin trial; the API is
 * absent everywhere else and this module is a no-op there, except in dev,
 * where installDevShim() installs the polyfill so the path is exercisable).
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
 * Dev shim: install the WebMCP polyfill so the registration path runs in any
 * browser under `pnpm dev`, without the Chrome origin trial. The import sits
 * inside the `import.meta.env.DEV` block on purpose: a build folds that to
 * `false`, which drops the block and the chunk with it (an early return would
 * leave the import reachable and ship it). A native `document.modelContext`
 * always wins: the polyfill returns early when one exists.
 *
 * The dependency is `@mcp-b/webmcp-polyfill`, a published vendor of the W3C
 * polyfill, because `@w3c/webmcp-polyfill` is not on npm yet (its roadmap
 * still lists publishing as a goal and the repo commits no build output).
 */
async function installDevShim(): Promise<void> {
  if (import.meta.env.DEV && !("modelContext" in document)) {
    const { installWebMCP } = await import("@mcp-b/webmcp-polyfill");
    installWebMCP();
  }
}

/**
 * Idempotent: skips entirely when the browser has no WebMCP API (or the
 * tools are already registered, e.g. after dev-server hot reload).
 */
export async function registerWebMcpTools(): Promise<void> {
  try {
    await installDevShim();
    const mc = modelContext();
    if (!mc) return;
    const existing = new Set((await mc.getTools()).map((t) => t.name));
    // Sequential on purpose: three quick calls at page load, deterministic
    // order, and no promise aggregator gymnastics for the skip case.
    for (const spec of READ_TOOLS) {
      if (existing.has(spec.name)) continue;
      await mc.registerTool({
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
    }
  } catch (err) {
    // The draft surface is not stable; a browser that rejects
    // mid-registration must cost a warning, never a page error.
    console.warn("[webmcp] tool registration failed:", err);
  }
}
