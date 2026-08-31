import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * app/lib/webmcp.ts: the in-page registration. No document.modelContext
 * (every browser without the Chrome 149 origin trial) is a silent no-op;
 * with the API present, exactly three read-only tools register, they hit
 * /api/webmcp/* with the right query strings, and a rerun never
 * re-registers (dev hot reload).
 */

const registered: {
  name: string;
  annotations: Record<string, unknown>;
  execute: (
    input: unknown,
    options: { signal?: AbortSignal },
  ) => Promise<unknown>;
}[] = [];

const modelContext = {
  registerTool: vi.fn(async (tool: (typeof registered)[number]) => {
    registered.push(tool);
  }),
  getTools: vi.fn(async () => registered.map((t) => ({ name: t.name }))),
};

const fetchMock = vi.fn(async (url: string | URL | Request) => ({
  ok: true,
  json: async () => ({ url: String(url) }),
}));

function installModelContext() {
  vi.stubGlobal("document", { modelContext });
  vi.stubGlobal("fetch", fetchMock);
}
function installNoModelContext() {
  vi.stubGlobal("document", {});
}

async function call(toolIndex: number, input: unknown) {
  return registered[toolIndex].execute(input, {});
}

describe("registerWebMcpTools", () => {
  afterEach(() => {
    registered.length = 0;
    modelContext.registerTool.mockClear();
    modelContext.getTools.mockClear();
    fetchMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("registers exactly the three read tools, marked read-only", async () => {
    installModelContext();
    const { registerWebMcpTools } = await import("~/lib/webmcp");
    await registerWebMcpTools();
    expect(registered.map((t) => t.name)).toEqual([
      "list_expenses",
      "expense_summary",
      "list_reports",
    ]);
    for (const tool of registered) {
      expect(tool.annotations).toEqual({ readOnlyHint: true });
    }
  });

  it("tools hit the JSON mirror with the given filters", async () => {
    installModelContext();
    const { registerWebMcpTools } = await import("~/lib/webmcp");
    await registerWebMcpTools();

    const list = (await call(0, { limit: 5, category: "Meals" })) as {
      url: string;
    };
    expect(list.url).toBe("/api/webmcp/expenses?limit=5&category=Meals");

    const summary = (await call(1, { dateFrom: "2026-01-01" })) as {
      url: string;
    };
    expect(summary.url).toBe("/api/webmcp/summary?dateFrom=2026-01-01");

    const reports = (await call(2, {})) as { url: string };
    expect(reports.url).toBe("/api/webmcp/reports");
  });

  it("is a silent no-op without the WebMCP API", async () => {
    installNoModelContext();
    const { registerWebMcpTools } = await import("~/lib/webmcp");
    await expect(registerWebMcpTools()).resolves.toBeUndefined();
    expect(modelContext.registerTool).not.toHaveBeenCalled();
  });

  it("does not re-register tools that already exist (hot reload)", async () => {
    installModelContext();
    const { registerWebMcpTools } = await import("~/lib/webmcp");
    await registerWebMcpTools();
    await registerWebMcpTools();
    expect(modelContext.registerTool).toHaveBeenCalledTimes(3);
  });

  it("degrades a rejecting draft API to a warning, never a rejection", async () => {
    installModelContext();
    modelContext.getTools.mockRejectedValueOnce(new Error("api gone"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registerWebMcpTools } = await import("~/lib/webmcp");
    await expect(registerWebMcpTools()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[webmcp] tool registration failed:",
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
