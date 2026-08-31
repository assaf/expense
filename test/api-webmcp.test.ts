import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/webmcp/:resource: the read-only JSON mirror the in-page WebMCP tools
 * (app/lib/webmcp.ts) fetch with the browser session. The loader and the
 * MCP handlers are thin adapters over the same implementations
 * (expense-read.server.ts) and contract (expense-read-tools.ts); these
 * tests run the real shared code through the loader, with only the DB and
 * the session mocked.
 */

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  readExpenses: vi.fn(async () => [] as Array<Record<string, unknown>>),
  readReportSummaries: vi.fn(async () => [] as Array<Record<string, unknown>>),
}));

vi.mock("~/lib/auth.server", () => ({
  requireUser: mocks.requireUser,
}));

vi.mock("~/lib/db/expenses", () => ({
  readExpenses: mocks.readExpenses,
}));

vi.mock("~/lib/db/reports", () => ({
  readReportSummaries: mocks.readReportSummaries,
}));

import { loader } from "~/routes/api.webmcp.$resource";

function args(resource: string, search = ""): Parameters<typeof loader>[0] {
  const request = new Request(
    `http://localhost/api/webmcp/${resource}${search}`,
  );
  return {
    request,
    url: new URL(request.url),
    params: { resource },
    pattern: "api/webmcp/:resource",
    context: {} as never,
  };
}

const USER = { id: "u1", accountId: "acc1" };

/** Minimal receipt-shaped expense covering the filter + wire-shape reads. */
function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: "e1",
    type: "receipt",
    date: "2026-08-01",
    report: "",
    category: "Meals",
    description: "Coffee",
    amount: "12.5",
    merchant: "Blue Bottle",
    currency: "USD",
    originalAmount: null,
    fxRate: null,
    locations: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as Record<string, unknown>;
}

describe("api.webmcp.$resource", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue(USER);
    mocks.readExpenses.mockResolvedValue([]);
    mocks.readReportSummaries.mockResolvedValue([]);
  });

  it("lists expenses newest first with the MCP wire shape", async () => {
    mocks.readExpenses.mockResolvedValue([
      receipt({ id: "e1", date: "2026-08-01", amount: "12.5" }),
      receipt({
        id: "e2",
        date: "2026-08-05",
        amount: "3.25",
        category: "Office",
      }),
    ]);
    const response = (await loader(args("expenses"))) as Response;
    const body = (await response.json()) as {
      count: number;
      returned: number;
      expenses: Array<{ id: string; amount: string; merchant: string }>;
    };
    expect(body.count).toBe(2);
    expect(body.returned).toBe(2);
    expect(body.expenses.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(body.expenses[0]).toMatchObject({
      id: "e2",
      amount: "3.25",
      merchant: "Blue Bottle",
      type: "receipt",
    });
  });

  it("clamps limit and reports the unfiltered count", async () => {
    mocks.readExpenses.mockResolvedValue([
      receipt({ id: "e1", date: "2026-08-01" }),
      receipt({ id: "e2", date: "2026-08-05" }),
      receipt({ id: "e3", date: "2026-08-09" }),
    ]);
    const response = (await loader(args("expenses", "?limit=2"))) as Response;
    const body = (await response.json()) as { count: number; returned: number };
    expect(body.count).toBe(3);
    expect(body.returned).toBe(2);
  });

  it("filters by category before counting", async () => {
    mocks.readExpenses.mockResolvedValue([
      receipt({ id: "e1", category: "Meals" }),
      receipt({ id: "e2", category: "Office" }),
    ]);
    const response = (await loader(
      args("expenses", "?category=meals"),
    )) as Response;
    const body = (await response.json()) as { count: number };
    expect(body.count).toBe(1);
  });

  it("summarizes with exact totals via the shared implementation", async () => {
    mocks.readExpenses.mockResolvedValue([
      receipt({ id: "e1", amount: "12.50", category: "Meals" }),
      receipt({ id: "e2", amount: "0.10", category: "Meals" }),
      receipt({ id: "e3", amount: "3.33", category: "Office" }),
    ]);
    const response = (await loader(args("summary"))) as Response;
    const body = (await response.json()) as {
      count: number;
      total: string;
      byCategory: Array<{ category: string; count: number; total: string }>;
    };
    expect(body.count).toBe(3);
    expect(body.total).toBe("15.93");
    expect(body.byCategory).toEqual([
      { category: "Meals", count: 2, total: "12.60" },
      { category: "Office", count: 1, total: "3.33" },
    ]);
  });

  it("passes report summaries through", async () => {
    mocks.readReportSummaries.mockResolvedValue([
      { name: "Q3 2026", count: 2, total: "15.93" },
    ]);
    const response = (await loader(args("reports"))) as Response;
    await expect(response.json()).resolves.toEqual([
      { name: "Q3 2026", count: 2, total: "15.93" },
    ]);
  });

  it("404s on unknown resources", async () => {
    await expect(loader(args("settings"))).rejects.toMatchObject({
      status: 404,
    });
  });
});
