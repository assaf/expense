import { expect } from "playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import sharp from "sharp";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { hashToken, issueTokenPair } from "~/lib/oauth.server";
import { runMcpSmoke } from "~/lib/mcp.server";
import {
  deleteOAuthClient,
  registerOAuthClient,
  revokeOAuthToken,
} from "~/lib/db/oauth";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

const baseURL = "http://localhost:5199";

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

  /** One POST to /mcp with the bearer token; returns status + parsed JSON. */
  async function mcpPost(
    token: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseURL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The MCP streamable HTTP spec requires this; the transport answers
        // 406 otherwise (real clients always send it).
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  /** 2025-era handshake (served statelessly — no session id is issued). */
  async function initialize(token: string): Promise<void> {
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
  }

  /** Parse the content from a MCP tools/call response into { isError, payload }. */
  function parseResult(json: unknown): {
    isError: boolean;
    payload: Record<string, unknown>;
  } {
    const result = (
      json as {
        result: { content: { text: string }[]; isError?: boolean };
      }
    ).result;
    const text = result.content?.[0]?.text ?? "";
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Non-JSON text (e.g. zod validation errors) — wrap it.
      payload = { error: text };
    }
    return {
      isError: Boolean(result.isError),
      payload,
    };
  }

  /** Call a tool (2025-era) and parse the result. */
  async function callTool(
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
    const res = await mcpPost(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect(res.status).toBe(200);
    return parseResult(res.json);
  }

  /** The 2026-07-28 per-request `_meta` envelope. */
  const MODERN_META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {
      name: "mcp-test",
      version: "1.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  /** 2026-07-28 era: tools/call carrying `_meta` + standard headers. */
  async function modernCallTool(
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
    const res = await mcpPost(
      token,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { _meta: MODERN_META, name, arguments: args },
      },
      { "Mcp-Method": "tools/call", "Mcp-Name": name },
    );
    expect(res.status).toBe(200);
    return parseResult(res.json);
  }

  // --- Tests ---

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
    await initialize(accessToken);
    const res = await mcpPost(accessToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
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

  it("serves 2026-07-28 stateless clients (discover + _meta envelope)", async () => {
    // No initialize, no session: every request carries its own envelope and
    // the standard headers. The probe answers with the server's identity.
    const discover = await mcpPost(
      accessToken,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: MODERN_META },
      },
      { "Mcp-Method": "server/discover" },
    );
    expect(discover.status).toBe(200);
    const discoverResult = (discover.json as { result: unknown }).result;
    expect(discoverResult).toBeTruthy();

    const list = await mcpPost(
      accessToken,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: { _meta: MODERN_META },
      },
      { "Mcp-Method": "tools/list" },
    );
    expect(list.status).toBe(200);
    const tools = (list.json as { result: { tools: { name: string }[] } })
      .result.tools;
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

    // Tools execute end-to-end in the modern era and stay account-scoped.
    const settings = await modernCallTool(accessToken, "get_settings", {});
    expect(settings.isError).toBe(false);
    expect(settings.payload).toHaveProperty("mileageRates");

    const other = await modernCallTool(otherAccessToken, "get_settings", {});
    expect(other.isError).toBe(false);

    // A modern-era capture writes a real expense with the image.
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
    const captured = await modernCallTool(accessToken, "capture_receipt", {
      imageData: png.toString("base64"),
      mime: "image/png",
      filename: "modern-receipt.png",
      date: "2026-04-29",
      report: "2026 Test",
    });
    expect(captured.isError).toBe(false);
    expect(captured.payload.captured).toBe(true);
    const expenseId = captured.payload.expenseId as string;
    const row = await testPrisma.expense.findFirst({
      where: { id: expenseId, accountId: TEST_ACCOUNT_ID },
    });
    expect(row).not.toBeNull();
    expect(row!.type).toBe("receipt");
    expect(row!.imageFile).not.toBe("");
  });

  it("dates capture_receipt in UTC when date is omitted and returns serverUtcNow", async () => {
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
    const captured = await modernCallTool(accessToken, "capture_receipt", {
      imageData: png.toString("base64"),
      mime: "image/png",
      filename: "utc-default.png",
      report: "2026 Test",
    });
    expect(captured.isError).toBe(false);
    // The response carries the server's UTC instant so the client can
    // resolve its own local date (server clock is UTC, client timezone
    // varies).
    const serverUtcNow = captured.payload.serverUtcNow as string;
    expect(serverUtcNow).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect((captured.payload.resolved as { date: string }).date).toBe(
      serverUtcNow.slice(0, 10),
    );
    const row = await testPrisma.expense.findFirst({
      where: {
        id: captured.payload.expenseId as string,
        accountId: TEST_ACCOUNT_ID,
      },
    });
    expect(row?.date).toBe(serverUtcNow.slice(0, 10));
  });

  it("rejects header/body mismatch on modern requests", async () => {
    // The Mcp-Name header must mirror params.name on tools/call.
    const res = await mcpPost(
      accessToken,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { _meta: MODERN_META, name: "get_settings", arguments: {} },
      },
      { "Mcp-Method": "tools/call", "Mcp-Name": "list_expenses" },
    );
    expect(res.status).toBe(400);
  });

  it("rejects capture_receipt with empty image data", async () => {
    await initialize(accessToken);
    const result = await callTool(accessToken, "capture_receipt", {
      imageData: "",
      mime: "image/png",
      filename: "empty.png",
    });
    expect(result.isError).toBe(true);
  });

  it("rejects capture_receipt URLs pointing at private hosts (SSRF)", async () => {
    await initialize(accessToken);
    const result = await callTool(accessToken, "capture_receipt", {
      url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.payload)).toContain("private");
  });

  it("rejects capture_receipt URLs with non-http(s) schemes (SSRF)", async () => {
    await initialize(accessToken);
    const result = await callTool(accessToken, "capture_receipt", {
      url: "file:///etc/passwd",
    });
    expect(result.isError).toBe(true);
  });

  it("rejects log_mileage with zero stops", async () => {
    await initialize(accessToken);
    const result = await callTool(accessToken, "log_mileage", {
      locations: [],
      date: "2026-05-10",
    });
    expect(result.isError).toBe(true);
  });

  it("rejects add_to_report with a non-existent expense id", async () => {
    await initialize(accessToken);
    const result = await callTool(accessToken, "add_to_report", {
      expenseId: "nonexistent-id",
      report: "2026 Test",
    });
    expect(result.isError).toBe(true);
  });

  it("rejects create_report with an empty name", async () => {
    await initialize(accessToken);
    const result = await callTool(accessToken, "create_report", {
      name: "",
    });
    expect(result.isError).toBe(true);
  });

  it("rejects export_report for a non-existent report", async () => {
    await initialize(accessToken);
    const result = await callTool(accessToken, "export_report", {
      name: "No Such Report",
    });
    expect(result.isError).toBe(true);
  });

  it("captures a receipt image into a real expense", async () => {
    await initialize(accessToken);
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
    const result = await callTool(accessToken, "capture_receipt", {
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
    await initialize(accessToken);
    const result = await callTool(accessToken, "log_mileage", {
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
    // The IRS rate is resolved from the master table by date + type:
    // 2026 H1 business is $0.725/mi.
    expect(payload.type).toBe("business");
    expect(payload.rate).toBe("0.725");

    // A different type picks a different rate for the same date: charity
    // is $0.14 every year.
    const charity = await callTool(accessToken, "log_mileage", {
      locations: [
        { address: "123 Test St, Testing, CA", lat: 34.0522, lng: -118.2437 },
        { address: "456 Dev Ave, Coding, CA", lat: 34.0622, lng: -118.2537 },
      ],
      date: "2026-05-10",
      type: "charity",
    });
    expect(charity.isError).toBe(false);
    expect(charity.payload.type).toBe("charity");
    expect(charity.payload.rate).toBe("0.14");

    const row = await testPrisma.expense.findFirst({
      where: { id: payload.expenseId as string, accountId: TEST_ACCOUNT_ID },
    });
    expect(row).not.toBeNull();
    expect(row!.type).toBe("mileage");
    expect(row!.distanceMiles).not.toBeNull();
    expect(row!.amount).not.toBeNull();
  });

  it("queries expenses and summarizes them (scoped to the account)", async () => {
    await initialize(accessToken);
    const summary = await callTool(accessToken, "expense_summary", {
      report: "2026 Test",
      dateFrom: "2026-01-01",
      dateTo: "2026-03-31",
    });
    expect(summary.isError).toBe(false);
    // Seeded rows in "2026 Test" before Apr: 42.50 + 15.99 + 22.40 + 0.00.
    expect(summary.payload.count).toBe(4);
    expect(summary.payload.total).toBe("80.89");

    const listed = await callTool(accessToken, "list_expenses", {
      merchant: "office",
      dateFrom: "2026-01-01",
      dateTo: "2026-03-31",
    });
    const expenses = (listed.payload as { expenses: { merchant: string }[] })
      .expenses;
    expect(expenses.length).toBe(1);
    expect(expenses[0]!.merchant).toBe("OfficeMax");

    // A token for another account only ever sees that account's rows.
    await initialize(otherAccessToken);
    const otherList = await callTool(otherAccessToken, "list_expenses", {});
    const otherExpenses = (
      otherList.payload as {
        expenses: { merchant: string }[];
      }
    ).expenses;
    expect(otherExpenses.length).toBe(1);
    expect(otherExpenses[0]!.merchant).toBe("Secret Corp");
  });

  it("builds reports: create, close (rejects new expenses), add, export PDF", async () => {
    await initialize(accessToken);

    const created = await callTool(accessToken, "create_report", {
      name: "MCP Report",
    });
    expect(created.isError).toBe(false);

    // Move the captured receipt from the earlier test into the new report.
    const receipt = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, date: "2026-04-28" },
    });
    const added = await callTool(accessToken, "add_to_report", {
      expenseId: receipt!.id,
      report: "MCP Report",
    });
    expect(added.isError).toBe(false);
    const moved = await testPrisma.expense.findUnique({
      where: { id: receipt!.id },
    });
    expect(moved!.report).toBe("MCP Report");

    // Closing a report freezes it.
    await callTool(accessToken, "close_report", {
      name: "2027 Test",
    });
    const rejected = await callTool(accessToken, "add_to_report", {
      expenseId: receipt!.id,
      report: "2027 Test",
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.payload)).toContain("closed");

    const pdf = await callTool(accessToken, "export_report", {
      name: "MCP Report",
    });
    expect(pdf.isError).toBe(false);
    const decoded = Buffer.from(pdf.payload.base64 as string, "base64");
    expect(decoded.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("reconciles a statement CSV against logged expenses (read-only)", async () => {
    await initialize(accessToken);
    const result = await callTool(accessToken, "reconcile", {
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

  it("connects with the real v2 client in both protocol eras", async () => {
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    // Default client mode = the 2025 initialize handshake, no probe.
    const legacy = new Client({ name: "v2-test", version: "1.0.0" });
    await legacy.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: authHeader },
      }),
    );
    expect(legacy.getProtocolEra()).toBe("legacy");
    const legacyTools = await legacy.listTools();
    expect(legacyTools.tools.length).toBe(13);
    await legacy.close();

    // mode: 'auto' probes server/discover and lands on the 2026-07-28 era.
    const modern = new Client(
      { name: "v2-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await modern.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: authHeader },
      }),
    );
    expect(modern.getProtocolEra()).toBe("modern");
    const settings = await modern.callTool({
      name: "get_settings",
      arguments: {},
    });
    const text = (settings.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text)).toHaveProperty("mileageRates");
    await modern.close();
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
    await initialize(accessToken);

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
