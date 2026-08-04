import { expect } from "playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import sharp from "sharp";
import { hashToken, issueTokenPair } from "~/lib/oauth.server";
import { runMcpSmoke } from "~/lib/mcp.server";
import {
  deleteOAuthClient,
  registerOAuthClient,
  revokeOAuthToken,
} from "~/lib/store.server";
import {
  OTHER_ACCOUNT_ID,
  TEST_ACCOUNT_ID,
  testPrisma,
} from "./helpers/seedTestData";

const baseURL = process.env.TEST_BASE_URL ?? "http://localhost:5199";

/**
 * End-to-end tests for the MCP endpoint (/mcp, Streamable HTTP). Auth is
 * OAuth-only: tokens are OAuth access tokens issued directly to the store
 * (the browser consent flow is covered separately in oauth.test.ts), then
 * exercised over real JSON-RPC HTTP calls.
 */
describe("MCP endpoint", () => {
  /** One OAuth client shared by the suite; its tokens cascade on delete. */
  let clientId = "";
  let accessToken = "";
  let otherAccessToken = "";

  beforeAll(async () => {
    const client = await registerOAuthClient({
      id: "mcp_test_client",
      secretHash: null,
      name: "mcp test",
      redirectUris: ["https://test.invalid/callback"],
      authMethod: "none",
    });
    clientId = client.id;
    // user_test1 → Test Account, user_test2 → Other Account (seed data).
    const [mine, other] = await Promise.all([
      issueTokenPair("user_test1", clientId),
      issueTokenPair("user_test2", clientId),
    ]);
    accessToken = mine.accessToken;
    otherAccessToken = other.accessToken;
  });

  afterAll(async () => {
    await deleteOAuthClient(clientId);
  });

  /** One POST to /mcp with the bearer token; returns status, session id, JSON. */
  async function mcpPost(
    token: string,
    body: unknown,
    sessionId?: string,
  ): Promise<{ status: number; sessionId: string | null; json: unknown }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // The MCP streamable HTTP spec requires this; the transport answers
      // 406 otherwise (real clients always send it).
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(`${baseURL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const sid = res.headers.get("mcp-session-id");
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, sessionId: sid, json };
  }

  /** Initialize a session (returns the session id) and send the initialized
   * notification, mirroring what an MCP client does. */
  async function initialize(token: string): Promise<string> {
    const init = await mcpPost(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-test", version: "1.0.0" },
      },
    });
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    const notified = await mcpPost(
      token,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      init.sessionId!,
    );
    expect(notified.status).toBe(202);
    return init.sessionId!;
  }

  /** Call a tool and parse the tool result payload (JSON text content). */
  async function callTool(
    token: string,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
    const res = await mcpPost(
      token,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      },
      sessionId,
    );
    expect(res.status).toBe(200);
    const result = (
      res.json as {
        result: { content: { text: string }[]; isError?: boolean };
      }
    ).result;
    const text = result.content?.[0]?.text ?? "";
    return {
      isError: Boolean(result.isError),
      payload: JSON.parse(text) as Record<string, unknown>,
    };
  }

  it("rejects requests without a valid OAuth token", async () => {
    const noAuth = await mcpPost("", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(noAuth.status).toBe(401);
    // A non-OAuth bearer (e.g. a former API-key style token) is rejected too.
    const badToken = await mcpPost("exp_this-is-not-an-oauth-token", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(badToken.status).toBe(401);
  });

  it("exposes the full tool surface over tools/list", async () => {
    const session = await initialize(accessToken);
    const res = await mcpPost(
      accessToken,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      session,
    );
    expect(res.status).toBe(200);
    const tools = (res.json as { result: { tools: { name: string }[] } }).result
      .tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_to_report",
        "capture_receipt",
        "close_report",
        "create_report",
        "expense_summary",
        "export_report",
        "get_settings",
        "list_categories",
        "list_expenses",
        "list_merchants",
        "list_reports",
        "log_mileage",
        "reconcile",
      ].sort(),
    );
  });

  it("captures a receipt image into a real expense", async () => {
    const session = await initialize(accessToken);
    const png = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();
    const result = await callTool(accessToken, session, "capture_receipt", {
      imageData: png.toString("base64"),
      mime: "image/png",
      filename: "test-receipt.png",
      date: "2026-04-28",
      report: "2026 Test",
    });
    expect(result.isError).toBe(false);
    const payload = result.payload;
    expect(payload.captured).toBe(true);
    const expenseId = payload.expenseId as string;

    const row = await testPrisma.expense.findFirst({
      where: { id: expenseId, accountId: TEST_ACCOUNT_ID },
    });
    expect(row).not.toBeNull();
    expect(row!.type).toBe("receipt");
    expect(row!.date).toBe("2026-04-28");
    expect(row!.report).toBe("2026 Test");
    expect(row!.imageFile).not.toBe("");
    const blob = await testPrisma.imageBlob.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, key: row!.imageFile },
    });
    expect(blob).not.toBeNull();
  });

  it("logs mileage with pre-geocoded stops and computes distance + amount", async () => {
    const session = await initialize(accessToken);
    const result = await callTool(accessToken, session, "log_mileage", {
      locations: [
        { address: "123 Test St, Testing, CA", lat: 34.0522, lng: -118.2437 },
        { address: "456 Dev Ave, Coding, CA", lat: 34.0622, lng: -118.2537 },
      ],
      date: "2026-05-10",
      report: "2026 Test",
      category: "Development",
      description: "MCP test trip",
    });
    expect(result.isError).toBe(false);
    const payload = result.payload;
    expect(payload.logged).toBe(true);
    expect(payload.distanceMiles).not.toBe("");
    expect(payload.amount).not.toBe("");

    const row = await testPrisma.expense.findFirst({
      where: { id: payload.expenseId as string, accountId: TEST_ACCOUNT_ID },
    });
    expect(row).not.toBeNull();
    expect(row!.type).toBe("mileage");
    expect(row!.distanceMiles).not.toBeNull();
    expect(row!.amount).not.toBeNull();
    const mileage = await testPrisma.mileage.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, date: "2026-05-10" },
    });
    expect(mileage).not.toBeNull();
  });

  it("queries expenses and summarizes them (scoped to the account)", async () => {
    const session = await initialize(accessToken);
    const summary = await callTool(accessToken, session, "expense_summary", {
      report: "2026 Test",
      dateFrom: "2026-01-01",
      dateTo: "2026-03-31",
    });
    expect(summary.isError).toBe(false);
    // Seeded rows in "2026 Test" before Apr: 42.50 + 15.99 + 22.40 + 0.00.
    expect(summary.payload.count).toBe(4);
    expect(summary.payload.total).toBe("80.89");

    const listed = await callTool(accessToken, session, "list_expenses", {
      merchant: "office",
      dateFrom: "2026-01-01",
      dateTo: "2026-03-31",
    });
    const expenses = (listed.payload as { expenses: { merchant: string }[] })
      .expenses;
    expect(expenses.length).toBe(1);
    expect(expenses[0]!.merchant).toBe("OfficeMax");

    // A token for another account only ever sees that account's rows.
    const otherSession = await initialize(otherAccessToken);
    const otherList = await callTool(
      otherAccessToken,
      otherSession,
      "list_expenses",
      {},
    );
    const otherExpenses = (
      otherList.payload as {
        expenses: { merchant: string }[];
      }
    ).expenses;
    expect(otherExpenses.length).toBe(1);
    expect(otherExpenses[0]!.merchant).toBe("Secret Corp");
  });

  it("builds reports: create, close (rejects new expenses), add, export PDF", async () => {
    const session = await initialize(accessToken);

    const created = await callTool(accessToken, session, "create_report", {
      name: "MCP Report",
    });
    expect(created.isError).toBe(false);

    // Move the captured receipt from the earlier test into the new report.
    const receipt = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, date: "2026-04-28" },
    });
    const added = await callTool(accessToken, session, "add_to_report", {
      expenseId: receipt!.id,
      report: "MCP Report",
    });
    expect(added.isError).toBe(false);
    const moved = await testPrisma.expense.findUnique({
      where: { id: receipt!.id },
    });
    expect(moved!.report).toBe("MCP Report");

    // Closing a report freezes it.
    await callTool(accessToken, session, "close_report", {
      name: "2027 Test",
    });
    const rejected = await callTool(accessToken, session, "add_to_report", {
      expenseId: receipt!.id,
      report: "2027 Test",
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.payload)).toContain("closed");

    const pdf = await callTool(accessToken, session, "export_report", {
      name: "MCP Report",
    });
    expect(pdf.isError).toBe(false);
    const decoded = Buffer.from(pdf.payload.base64 as string, "base64");
    expect(decoded.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("reconciles a statement CSV against logged expenses (read-only)", async () => {
    const session = await initialize(accessToken);
    const result = await callTool(accessToken, session, "reconcile", {
      statementCsv: [
        "date,description,amount",
        "2026-01-15,TEST STORE PURCHASE,42.50",
        "2026-07-01,UNKNOWN COFFEE SHOP,9.99",
      ].join("\n"),
    });
    expect(result.isError).toBe(false);
    const payload = result.payload as {
      matchedPairs: { confidence: string; merchant: string }[];
      unmatchedLines: unknown[];
      unmatchedExpenses: unknown[];
    };
    expect(payload.matchedPairs.length).toBe(1);
    expect(payload.matchedPairs[0]!.merchant).toBe("Test Store");
    expect(payload.matchedPairs[0]!.confidence).toBe("high");
    expect(payload.unmatchedLines.length).toBe(1);
    // Every receipt except the Test Store one has no statement line.
    expect(payload.unmatchedExpenses.length).toBeGreaterThan(1);
  });

  it("runs the post-deploy smoke MCP round trip and cleans up its client", async () => {
    const result = await runMcpSmoke();
    expect(result.tools).toBe(13);
    expect(result.ms).toBeGreaterThan(0);
    // The throwaway OAuth client (and its tokens) are always removed.
    const leftover = await testPrisma.oAuthClient.findFirst({
      where: { name: "smoke check" },
    });
    expect(leftover).toBeNull();
  });

  it("rejects a revoked access token", async () => {
    const session = await initialize(accessToken);
    expect(session).toBeTruthy();

    await revokeOAuthToken(hashToken(accessToken));
    const res = await mcpPost(accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(res.status).toBe(401);
  });
});
