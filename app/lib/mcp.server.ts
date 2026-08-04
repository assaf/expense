import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import Decimal from "decimal.js";
import { hashApiToken, isApiToken } from "~/lib/api-tokens.server";
import { isOAuthToken, verifyAccessToken } from "~/lib/oauth.server";
import {
  findApiTokenByHash,
  touchApiToken,
  findUserById,
  readExpenses,
  readExpense,
  readReports,
  readReportCounts,
  readCategories,
  readSettings,
  readExtractionContext,
  readPriorMerchants,
  addReport,
  setReportClosed,
  upsertExpense,
  newExpenseShell,
  createApiToken,
  revokeApiToken,
  readBootstrapAccountId,
} from "~/lib/store.server";
import {
  normalizeAmount,
  parseAmount,
  sortExpenses,
  todayDate,
  yearOf,
  summarizeByReport,
} from "~/lib/format";
import { saveImage, renameImageToConvention } from "~/lib/images.server";
import { recomputeMileage } from "~/lib/maps.server";
import { resolveCategory } from "~/lib/receipt-ai.server";
import { extractFromImage } from "~/lib/receipt-ocr.server";
import { buildReportPdf } from "~/lib/report-pdf.server";
import { validateDateNotFuture } from "~/lib/validation";
import type {
  Expense,
  Location,
  MileageExpense,
  ReceiptExpense,
} from "~/lib/types";

/**
 * The MCP server for the expense tracker — the agent-facing window onto the
 * same store the web app uses (POST /mcp, bearer-token auth).
 *
 * Tool design principle: expose capabilities, not CRUD. The flagship tool,
 * capture_receipt, runs the app's own extraction pipeline (DeepSeek /
 * tesseract + the account's merchant→category memory) so an agent can drop
 * a receipt photo/PDF and get a filed expense — the same work the web UI
 * does, without a form.
 *
 * Transport: MCP Streamable HTTP (WebStandardStreamableHTTPServerTransport).
 * Each initialized session gets a transport + server instance bound to the
 * account and capabilities (readOnly) of the bearer token that created it;
 * subsequent requests must present a token for the same account with the
 * same capabilities. Sessions live in a module-level map — on serverless
 * cold starts sessions are lost and clients re-initialize (spec-compliant
 * 404 → re-init).
 */

/** Read-only tokens may call query tools but every write tool refuses. */
const READ_ONLY_MESSAGE =
  "This token is read-only — it can query expenses but cannot create or change them.";

/** The largest receipt bytes a capture tool accepts (matches a phone photo). */
const MAX_CAPTURE_BYTES = 15_000_000;

/** One authenticated MCP session, bound to a transport + server instance. */
interface McpSession {
  accountId: string;
  readOnly: boolean;
  transport: WebStandardStreamableHTTPServerTransport;
}

const sessions = new Map<string, McpSession>();

// --- HTTP handling ---------------------------------------------------------

/**
 * Handle any request to /mcp: authenticate the bearer token, route to the
 * session's transport (creating one for a fresh initialize), and translate
 * the SDK's Response back to the caller. Loaders and actions both land here.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;

  const sessionId = request.headers.get("mcp-session-id");
  const method = request.method.toUpperCase();

  if (method === "DELETE") {
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) return jsonError(request, 404, "No such session.");
    if (
      session.accountId !== auth.accountId ||
      session.readOnly !== auth.readOnly
    ) {
      return jsonError(request, 401, "Token does not match the session.");
    }
    const response = await session.transport.handleRequest(request);
    if (sessionId) sessions.delete(sessionId);
    await session.transport.close().catch(() => {});
    return response;
  }

  if (method === "GET") {
    // SSE resumption requires an established session (sessions are
    // server-generated; there is no anonymous standalone stream).
    if (!sessionId)
      return jsonError(
        request,
        400,
        "A session is required — POST an initialize request first.",
      );
    const session = sessions.get(sessionId);
    if (!session) return jsonError(request, 404, "No such session.");
    if (
      session.accountId !== auth.accountId ||
      session.readOnly !== auth.readOnly
    ) {
      return jsonError(request, 401, "Token does not match the session.");
    }
    return session.transport.handleRequest(request);
  }

  if (method === "POST") {
    if (!sessionId) return createSession(auth, request);
    const session = sessions.get(sessionId);
    if (!session)
      return jsonError(
        request,
        404,
        "Session expired or unknown — initialize again.",
      );
    if (
      session.accountId !== auth.accountId ||
      session.readOnly !== auth.readOnly
    ) {
      return jsonError(request, 401, "Token does not match the session.");
    }
    return session.transport.handleRequest(request);
  }

  return jsonError(request, 405, "Method not allowed.");
}

/**
 * Validate `Authorization: Bearer …` and resolve the account + capabilities.
 * Two token kinds are accepted:
 *  - `exp_…` API tokens from Settings → Agents & API (account-scoped, may be
 *    read-only);
 *  - `oat_…` OAuth access tokens from the authorization-code flow, which
 *    authenticate the user who signed in (their account, full access).
 * Unauthenticated requests get a 401 carrying the RFC 9728 protected-resource
 * hint so OAuth-capable clients can start discovery.
 */
async function authenticateRequest(
  request: Request,
): Promise<{ accountId: string; readOnly: boolean } | Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return jsonError(request, 401, MISSING_TOKEN_MESSAGE);

  if (isApiToken(token)) {
    const found = await findApiTokenByHash(hashApiToken(token));
    if (!found)
      return jsonError(
        request,
        401,
        "Unknown token — it may have been revoked.",
      );
    // Last-used stamping is best-effort bookkeeping, never awaited.
    void touchApiToken(found.id);
    return { accountId: found.accountId, readOnly: found.readOnly };
  }

  if (isOAuthToken(token)) {
    const verified = await verifyAccessToken(token);
    if (!verified)
      return jsonError(
        request,
        401,
        "Unknown or expired access token — sign in again.",
      );
    const user = await findUserById(verified.userId);
    if (!user)
      return jsonError(request, 401, "Unknown account — sign in again.");
    return { accountId: user.accountId, readOnly: false };
  }

  return jsonError(request, 401, MISSING_TOKEN_MESSAGE);
}

/** Shown when no bearer token is present or it isn't one of ours. */
const MISSING_TOKEN_MESSAGE =
  "Missing bearer token — connect with OAuth (sign in) or create an API token in Settings → Agents & API.";

/**
 * A 401 with the OAuth protected-resource metadata hint (RFC 9728), so
 * clients that perform discovery can find the authorization server.
 */
function jsonError(
  request: Request,
  status: number,
  message: string,
): Response {
  const origin = new URL(request.url).origin;
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

/** Initialize a fresh session bound to this token's account + capabilities. */
async function createSession(
  auth: { accountId: string; readOnly: boolean },
  request: Request,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // JSON responses instead of SSE streams — simpler for CLI agents and
    // tests, and keeps serverless functions from holding a stream open.
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      sessions.set(id, {
        accountId: auth.accountId,
        readOnly: auth.readOnly,
        transport,
      });
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });
  const server = createMcpServer(auth.accountId, auth.readOnly);
  await server.connect(transport);
  return transport.handleRequest(request);
}

// --- Tool results ----------------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Success payload, JSON-encoded so agents get structured data. */
function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** Error payload with isError set so clients surface it to the agent. */
function fail(message: string): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: message }, null, 2) },
    ],
    isError: true,
  };
}

// --- Server + tools --------------------------------------------------------

/** The tools a healthy server must expose — the deployed-bundle check. */
const SMOKE_TOOL_NAMES = [
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
] as const;

/**
 * Post-deploy MCP smoke check (called from GET /api/smoke): a real
 * initialize → tools/list → tools/call round trip through `handleMcpRequest`
 * — the exact code /mcp serves — authenticated with a one-off token that is
 * revoked afterwards. Proves the MCP SDK + zod survived Vercel's dependency
 * tracer in the serverless bundle and that the endpoint can serve a client
 * against the real database. Throws with a message on any failure.
 */
export async function runMcpSmoke(): Promise<{ tools: number; ms: number }> {
  const accountId = await readBootstrapAccountId();
  if (!accountId) {
    throw new Error(
      "no account to exercise the MCP endpoint against (empty database?)",
    );
  }
  const started = Date.now();
  const { id, token } = await createApiToken({
    accountId,
    name: "smoke check",
    readOnly: false,
  });
  let sessionId: string | null = null;
  try {
    const request = (body: unknown, sid?: string): Request => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        // The transport answers 406 without the spec's Accept header.
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      };
      if (sid) headers["mcp-session-id"] = sid;
      return new Request("http://smoke.local/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    };

    const init = await handleMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "smoke", version: "1.0.0" },
        },
      }),
    );
    if (init.status !== 200) {
      throw new Error(`MCP initialize failed: HTTP ${init.status}`);
    }
    sessionId = init.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new Error("MCP initialize returned no session id");
    }

    const notified = await handleMcpRequest(
      request(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId,
      ),
    );
    if (notified.status !== 202) {
      throw new Error(
        `MCP initialized notification failed: HTTP ${notified.status}`,
      );
    }

    const list = await handleMcpRequest(
      request(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        sessionId,
      ),
    );
    if (list.status !== 200) {
      throw new Error(`MCP tools/list failed: HTTP ${list.status}`);
    }
    const listJson = (await list.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (listJson.result?.tools ?? []).map((t) => t.name);
    for (const expected of SMOKE_TOOL_NAMES) {
      if (!names.includes(expected)) {
        throw new Error(`MCP tool missing from the bundle: ${expected}`);
      }
    }

    const call = await handleMcpRequest(
      request(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "get_settings", arguments: {} },
        },
        sessionId,
      ),
    );
    if (call.status !== 200) {
      throw new Error(`MCP tools/call failed: HTTP ${call.status}`);
    }
    const callJson = (await call.json()) as {
      result?: { isError?: boolean; content?: { text: string }[] };
    };
    if (callJson.result?.isError) {
      throw new Error(
        `MCP tools/call get_settings errored: ${callJson.result.content?.[0]?.text ?? "no content"}`,
      );
    }

    return { tools: names.length, ms: Date.now() - started };
  } finally {
    // Always clean up: the one-off token and its session.
    await revokeApiToken(accountId, id);
    if (sessionId) {
      await handleMcpRequest(
        new Request("http://smoke.local/mcp", {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "mcp-session-id": sessionId,
          },
        }),
      ).catch(() => {});
    }
  }
}

function createMcpServer(accountId: string, readOnly: boolean): McpServer {
  const server = new McpServer({ name: "expense", version: "0.1.0" });

  // --- capture_receipt -----------------------------------------------------

  server.tool(
    "capture_receipt",
    "Capture a receipt from a base64 image/PDF or a URL: extract the merchant, amount and category (reusing the merchant's previous category when known), store the image, and create the expense. Returns the extracted fields and the new expense id.",
    {
      imageData: z
        .string()
        .optional()
        .describe(
          "Base64-encoded receipt image (PNG/JPEG/HEIC/WebP) or PDF bytes.",
        ),
      mime: z
        .string()
        .optional()
        .describe(
          "MIME type of imageData, e.g. image/png or application/pdf. Guessed from filename when omitted.",
        ),
      filename: z
        .string()
        .optional()
        .describe("Original filename; used for the stored image name."),
      url: z
        .string()
        .optional()
        .describe(
          "URL of a receipt image or PDF to fetch instead of imageData.",
        ),
      merchant: z
        .string()
        .optional()
        .describe("Merchant override (otherwise extracted)."),
      amount: z
        .string()
        .optional()
        .describe(
          'Amount override as a decimal string, e.g. "42.50" (otherwise extracted).',
        ),
      category: z
        .string()
        .optional()
        .describe(
          "Category override (otherwise resolved from the merchant's history, then the extraction suggestion).",
        ),
      date: z
        .string()
        .optional()
        .describe("Expense date YYYY-MM-DD (defaults to today)."),
      report: z
        .string()
        .optional()
        .describe("Report name to file under; must already exist and be open."),
      description: z.string().optional().describe("Description or memo."),
    },
    async (args) => {
      const blocked = writeGuard(readOnly);
      if (blocked) return fail(blocked);
      return captureReceipt(accountId, args);
    },
  );

  // --- log_mileage ---------------------------------------------------------

  server.tool(
    "log_mileage",
    "Log a driving trip: geocode the stops, compute the route distance with the account's mileage rate for the year, and create the mileage expense (and the derived mileage row).",
    {
      locations: z
        .array(
          z.union([
            z.string().describe("Address to geocode."),
            z.object({
              address: z.string(),
              lat: z
                .number()
                .optional()
                .describe("Pre-known latitude — skips geocoding."),
              lng: z
                .number()
                .optional()
                .describe("Pre-known longitude — skips geocoding."),
            }),
          ]),
        )
        .min(2)
        .describe(
          "Ordered trip stops: start, intermediate stops, end. Each is an address string or a pre-geocoded { address, lat, lng }.",
        ),
      date: z
        .string()
        .optional()
        .describe("Trip date YYYY-MM-DD (defaults to today)."),
      report: z
        .string()
        .optional()
        .describe("Report name to file under; must already exist and be open."),
      category: z.string().optional().describe("Category name."),
      description: z.string().optional().describe("Description or memo."),
    },
    async (args) => {
      const blocked = writeGuard(readOnly);
      if (blocked) return fail(blocked);
      return logMileage(accountId, args);
    },
  );

  // --- list_expenses -------------------------------------------------------

  server.tool(
    "list_expenses",
    "Query expenses with optional filters (date range, category, merchant, report, unreported-only, type). Returns newest first. Amounts are decimal strings.",
    {
      dateFrom: z
        .string()
        .optional()
        .describe("Inclusive start date YYYY-MM-DD."),
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows (default 100)."),
    },
    async (args) => {
      const expenses = await readExpenses(accountId);
      const filtered = filterExpenses(expenses, args);
      const limited = sortExpenses(filtered).slice(0, args.limit ?? 100);
      return ok({
        count: filtered.length,
        returned: limited.length,
        expenses: limited.map(serializeExpense),
      });
    },
  );

  // --- expense_summary -----------------------------------------------------

  server.tool(
    "expense_summary",
    'Totals for expenses matching the filters: overall count + sum, and per-category breakdown. The answer to "how much did I spend on X?".',
    {
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      category: z.string().optional(),
      merchant: z.string().optional(),
      report: z.string().optional(),
      unreported: z.boolean().optional(),
      type: z.enum(["receipt", "mileage"]).optional(),
    },
    async (args) => {
      const expenses = filterExpenses(await readExpenses(accountId), args);
      const total = expenses.reduce((sum, e) => {
        const amt = parseAmount(e.amount);
        return amt === null ? sum : sum.add(amt);
      }, new Decimal(0));
      const byCategory = new Map<string, { count: number; total: Decimal }>();
      for (const e of expenses) {
        const key = e.category || "Uncategorized";
        const bucket = byCategory.get(key) ?? {
          count: 0,
          total: new Decimal(0),
        };
        bucket.count++;
        const amt = parseAmount(e.amount);
        if (amt !== null) bucket.total = bucket.total.add(amt);
        byCategory.set(key, bucket);
      }
      const breakdown = [...byCategory.entries()]
        .map(([category, b]) => ({
          category,
          count: b.count,
          total: b.total.toFixed(2),
        }))
        .sort((a, b) => (a.total < b.total ? 1 : a.total > b.total ? -1 : 0));
      return ok({
        count: expenses.length,
        total: total.toFixed(2),
        byCategory: breakdown,
      });
    },
  );

  // --- list_reports --------------------------------------------------------

  server.tool(
    "list_reports",
    "All reports with their expense counts and exact totals.",
    {},
    async () => {
      const [reports, reportCounts, expenses] = await Promise.all([
        readReports(accountId),
        readReportCounts(accountId),
        readExpenses(accountId),
      ]);
      const totals = summarizeByReport(expenses);
      return ok(
        reports.map((r) => ({
          name: r.name,
          closed: r.closed,
          count: reportCounts.get(r.name) ?? 0,
          total: totals.get(r.name)?.total.toFixed(2) ?? "0.00",
        })),
      );
    },
  );

  // --- create_report / close_report / add_to_report ------------------------

  server.tool(
    "create_report",
    'Create a report (e.g. "Q3 2026") to group expenses. Fails if the name already exists.',
    { name: z.string().min(1).describe("Report name.") },
    async ({ name }) => {
      const blocked = writeGuard(readOnly);
      if (blocked) return fail(blocked);
      const result = await addReport(accountId, name);
      return result.ok ? ok({ name }) : fail(result.error);
    },
  );

  server.tool(
    "close_report",
    "Close (or reopen) a report. Closed reports refuse new expenses.",
    {
      name: z.string().min(1),
      closed: z.boolean().optional().describe("Default true."),
    },
    async ({ name, closed }) => {
      const blocked = writeGuard(readOnly);
      if (blocked) return fail(blocked);
      await setReportClosed(accountId, name, closed ?? true);
      return ok({ name, closed: closed ?? true });
    },
  );

  server.tool(
    "add_to_report",
    "Move an expense into a report (must exist and be open). Also renames the stored receipt image to the dated convention name when the expense has a date and original filename.",
    {
      expenseId: z.string().min(1),
      report: z.string().min(1).describe("Existing, open report name."),
    },
    async ({ expenseId, report }) => {
      const blocked = writeGuard(readOnly);
      if (blocked) return fail(blocked);
      const expense = await readExpense(expenseId, accountId);
      if (!expense) return fail(`No expense with id "${expenseId}".`);
      const reports = await readReports(accountId);
      const target = reports.find((r) => r.name === report);
      if (!target)
        return fail(
          `Report "${report}" doesn't exist — create it first with create_report.`,
        );
      if (target.closed) return fail(`Report "${report}" is closed.`);
      const updated: Expense = {
        ...expense,
        report,
        updatedAt: new Date().toISOString(),
      };
      if (
        updated.type === "receipt" &&
        updated.imageFile &&
        updated.date &&
        updated.originalName
      ) {
        updated.imageFile = await renameImageToConvention(
          accountId,
          updated.imageFile,
          updated.date,
          report,
          updated.originalName,
          updated.imageMime,
        );
      }
      await upsertExpense(updated, accountId);
      return ok({ expenseId, report });
    },
  );

  // --- export_report -------------------------------------------------------

  server.tool(
    "export_report",
    "Render a report as a PDF (the same layout as the web export: grouped by category, with a receipt images appendix) and return it base64-encoded. Decode and save as a .pdf file.",
    { name: z.string().min(1).describe("Report name.") },
    async ({ name }) => {
      const reports = await readReports(accountId);
      if (!reports.some((r) => r.name === name)) {
        return fail(`Report "${name}" doesn't exist.`);
      }
      const pdf = await buildReportPdf(
        accountId,
        name,
        await readExpenses(accountId),
        reports,
      );
      return ok({
        filename: `${name}.pdf`,
        mime: "application/pdf",
        sizeBytes: pdf.length,
        base64: pdf.toString("base64"),
        note: "Decode the base64 payload and save it as a .pdf file.",
      });
    },
  );

  // --- list_categories / list_merchants / get_settings ---------------------

  server.tool(
    "list_categories",
    "The account's category names (alphabetical) — use these when categorizing expenses.",
    {},
    async () => {
      const categories = await readCategories(accountId);
      return ok(categories.map((c) => c.name));
    },
  );

  server.tool(
    "list_merchants",
    "Merchant names previously used, most recent first.",
    {},
    async () => ok(await readPriorMerchants(accountId)),
  );

  server.tool(
    "get_settings",
    "Account settings: per-year mileage reimbursement rates and the home address.",
    {},
    async () => {
      const settings = await readSettings(accountId);
      return ok({
        mileageRates: settings.mileageRates,
        homeAddress: settings.homeAddress,
      });
    },
  );

  // --- reconcile -----------------------------------------------------------

  server.tool(
    "reconcile",
    "Match a bank statement against logged expenses. Pass the statement as CSV (header row optional; date, description and amount columns — amounts may include $ and parentheses for negatives). Returns matched pairs, statement lines with no matching receipt, and logged receipts with no statement line.",
    { statementCsv: z.string().min(1) },
    async ({ statementCsv }) => {
      const expenses = await readExpenses(accountId);
      return ok(reconcileStatement(statementCsv, expenses));
    },
  );

  return server;
}

// --- Tool implementations --------------------------------------------------

function writeGuard(readOnly: boolean): string | null {
  return readOnly ? READ_ONLY_MESSAGE : null;
}

/** Shared filters for list_expenses and expense_summary. */
interface ExpenseFilters {
  dateFrom?: string;
  dateTo?: string;
  category?: string;
  merchant?: string;
  report?: string;
  unreported?: boolean;
  type?: "receipt" | "mileage";
}

function filterExpenses(expenses: Expense[], f: ExpenseFilters): Expense[] {
  return expenses.filter((e) => {
    if (f.dateFrom && (!e.date || e.date < f.dateFrom)) return false;
    if (f.dateTo && (!e.date || e.date > f.dateTo)) return false;
    if (f.category && e.category.toLowerCase() !== f.category.toLowerCase())
      return false;
    if (f.merchant) {
      const q = f.merchant.toLowerCase();
      const hay =
        e.type === "receipt"
          ? e.merchant
          : e.locations.map((l) => l.address).join(" ");
      if (!hay.toLowerCase().includes(q)) return false;
    }
    if (f.report && e.report !== f.report) return false;
    if (f.unreported && e.report !== "") return false;
    if (f.type && e.type !== f.type) return false;
    return true;
  });
}

/** The wire shape of an expense: JSON-safe, money as decimal strings. */
function serializeExpense(e: Expense) {
  return {
    id: e.id,
    type: e.type,
    date: e.date || null,
    report: e.report || null,
    category: e.category || null,
    description: e.description,
    amount: e.amount || null,
    ...(e.type === "receipt"
      ? { merchant: e.merchant || null }
      : {
          distanceMiles: e.distanceMiles || null,
          stops: e.locations.map((l) => l.address).filter(Boolean),
        }),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/**
 * Capture a receipt: decode the input, run the app's extraction pipeline
 * (DeepSeek vision/OCR, falling back to tesseract; category resolved from
 * the merchant's own history), persist the image, and create the expense.
 * Extraction failure never blocks the capture — the image is still stored
 * and the expense created with the fields we have (mirrors the draft flow).
 */
async function captureReceipt(
  accountId: string,
  args: {
    imageData?: string;
    mime?: string;
    filename?: string;
    url?: string;
    merchant?: string;
    amount?: string;
    category?: string;
    date?: string;
    report?: string;
    description?: string;
  },
): Promise<ToolResult> {
  let buffer: Buffer;
  let mime: string;
  let originalName: string;

  if (args.imageData) {
    buffer = Buffer.from(args.imageData, "base64");
    mime = args.mime?.trim() || guessMime(args.filename) || "image/png";
    originalName = args.filename?.trim() || "receipt.png";
  } else if (args.url) {
    let res: Response;
    try {
      res = await fetch(args.url, { signal: AbortSignal.timeout(20_000) });
    } catch {
      return fail(`Couldn't fetch ${args.url}: network error or timeout.`);
    }
    if (!res.ok) return fail(`Couldn't fetch ${args.url}: HTTP ${res.status}.`);
    const data = await res.arrayBuffer();
    buffer = Buffer.from(data);
    const fromUrl = args.filename?.trim() || urlFilename(args.url) || "receipt";
    mime =
      args.mime?.trim() ||
      res.headers.get("content-type")?.split(";")[0]?.trim() ||
      guessMime(fromUrl) ||
      "image/png";
    originalName = fromUrl;
  } else {
    return fail("Provide either imageData (base64) or url.");
  }

  if (buffer.length === 0) return fail("Empty image data.");
  if (buffer.length > MAX_CAPTURE_BYTES) {
    return fail("Image too large — receipts must be under 15MB.");
  }

  // Extraction: best-effort. The capture still succeeds without it.
  const { categories, merchantCategories } =
    await readExtractionContext(accountId);
  let extracted: {
    isReceipt: boolean;
    merchant: string;
    amount: string;
    category: string;
    confidence: string;
    notes: string;
  } | null = null;
  try {
    const { result, stored } = await extractFromImage({
      buffer,
      mime,
      categories,
    });
    extracted = {
      isReceipt: result.isReceipt,
      merchant: result.merchant,
      amount: result.amount,
      category: result.category,
      confidence: result.confidence,
      notes: result.notes,
    };
    buffer = stored.buffer;
    mime = stored.mime;
  } catch (err) {
    console.warn("[mcp] capture_receipt extraction failed:", err);
  }

  const merchant = args.merchant?.trim() || extracted?.merchant || "";
  const category = resolveCategory(
    merchant,
    args.category ?? extracted?.category ?? "",
    merchantCategories,
    categories,
  );
  const amount = normalizeAmount(args.amount ?? extracted?.amount ?? "");
  const date = args.date ?? todayDate();
  const dateError = validateDateNotFuture(date);
  if (dateError) return fail(dateError);

  const report = args.report?.trim() ?? "";
  if (report) {
    const reports = await readReports(accountId);
    const target = reports.find((r) => r.name === report);
    if (!target)
      return fail(
        `Report "${report}" doesn't exist — create it first with create_report.`,
      );
    if (target.closed) return fail(`Report "${report}" is closed.`);
  }

  const saved = await saveImage(accountId, buffer, mime, originalName);
  const expense: ReceiptExpense = {
    ...(newExpenseShell("receipt") as ReceiptExpense),
    date,
    report,
    category,
    description: args.description ?? "",
    amount,
    merchant,
    imageFile: saved.filename,
    imageMime: saved.mime,
    originalName,
  };
  if (date && report && originalName) {
    expense.imageFile = await renameImageToConvention(
      accountId,
      expense.imageFile,
      date,
      report,
      originalName,
      saved.mime,
    );
  }
  await upsertExpense(expense, accountId);

  const warning =
    extracted === null
      ? "Receipt stored, but extraction failed — merchant/amount/category were not filled in."
      : !extracted.isReceipt
        ? "The content may not be a receipt — captured anyway with the fields found."
        : null;
  return ok({
    captured: true,
    expenseId: expense.id,
    extracted,
    resolved: { merchant, amount, category, date, report },
    ...(warning ? { warning } : {}),
  });
}

/** Geocode + route a trip and create the mileage expense. */
async function logMileage(
  accountId: string,
  args: {
    locations: (string | { address: string; lat?: number; lng?: number })[];
    date?: string;
    report?: string;
    category?: string;
    description?: string;
  },
): Promise<ToolResult> {
  const date = args.date ?? todayDate();
  const dateError = validateDateNotFuture(date);
  if (dateError) return fail(dateError);

  const report = args.report?.trim() ?? "";
  if (report) {
    const reports = await readReports(accountId);
    const target = reports.find((r) => r.name === report);
    if (!target)
      return fail(
        `Report "${report}" doesn't exist — create it first with create_report.`,
      );
    if (target.closed) return fail(`Report "${report}" is closed.`);
  }

  const stops: Location[] = args.locations.map((l) =>
    typeof l === "string"
      ? { address: l, lat: null, lng: null }
      : { address: l.address, lat: l.lat ?? null, lng: l.lng ?? null },
  );
  if (stops.filter((s) => s.address.trim() !== "").length < 2) {
    return fail("A trip needs at least two stops.");
  }

  const settings = await readSettings(accountId);
  const rate = settings.mileageRates[yearOf(date)] ?? "";
  const {
    locations,
    distanceMiles,
    amount,
    approximate,
    coords,
    returnCoords,
  } = await recomputeMileage(stops, rate);

  const expense: MileageExpense = {
    ...(newExpenseShell("mileage") as MileageExpense),
    date,
    report,
    category: args.category?.trim() ?? "",
    description: args.description ?? "",
    amount,
    locations,
    distanceMiles,
    route: { coords, returnCoords },
  };
  await upsertExpense(expense, accountId);

  return ok({
    logged: true,
    expenseId: expense.id,
    stops: locations.map((l) => l.address),
    distanceMiles,
    amount,
    approximate,
    ...(approximate
      ? {
          note: "Route service unavailable — distance is straight-line; re-save the expense later to recompute.",
        }
      : {}),
  });
}

/** Mime guess from a filename extension, mirroring images.server.ts. */
function guessMime(filename: string | undefined): string {
  const ext = (filename ?? "").toLowerCase().split(".").pop();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "pdf":
      return "application/pdf";
    case "gif":
      return "image/gif";
    default:
      return "";
  }
}

function urlFilename(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ?? "";
  } catch {
    return "";
  }
}

// --- Reconciliation --------------------------------------------------------

/** Parse CSV text (RFC 4180-ish: quotes, doubled quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** Normalize a statement date to YYYY-MM-DD (ISO or US MM/DD/YYYY). */
function normalizeStatementDate(value: string): string | null {
  const s = value.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  }
  return null;
}

/** Parse a statement amount: $ and commas stripped, (12.34) is negative. */
function parseStatementAmount(value: string): Decimal | null {
  const s = value.trim();
  if (!s) return null;
  let neg = false;
  let body = s;
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    body = s.slice(1, -1);
  }
  const m = body.replace(/[$,\s]/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const d = new Decimal(m[0]);
  return neg ? d.neg() : d;
}

/** Word tokens (≥3 chars, lowercased) for merchant/description overlap. */
function tokensOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

interface StatementRow {
  date: string | null;
  description: string;
  amount: Decimal | null;
  raw: string[];
}

/** Split statement rows into (date, description, amount) triples. */
function parseStatementRows(text: string): {
  rows: StatementRow[];
  skipped: string[];
} {
  const raw = parseCsv(text);
  const rows: StatementRow[] = [];
  const skipped: string[] = [];
  if (raw.length === 0) return { rows, skipped };

  // Column mapping: use a header row when one is recognizable.
  const header = raw[0]!.map((h) => h.trim().toLowerCase());
  const dateIdx = header.findIndex((h) => /date/.test(h));
  const descIdx = header.findIndex((h) => /desc|merchant|payee|name/.test(h));
  const amtIdx = header.findIndex((h) => /amount|debit|credit/.test(h));
  const hasHeader = dateIdx >= 0 || amtIdx >= 0;
  const body = hasHeader ? raw.slice(1) : raw;

  for (const cells of body) {
    const date = hasHeader
      ? normalizeStatementDate(cells[dateIdx] ?? "")
      : normalizeStatementDate(cells[0] ?? "");
    const description = hasHeader
      ? (cells[descIdx] ?? "").trim()
      : (cells[1] ?? "").trim();
    const amount = parseStatementAmount(
      hasHeader ? (cells[amtIdx] ?? "") : (cells[2] ?? ""),
    );
    if (date === null || amount === null) {
      skipped.push(cells.join(","));
      continue;
    }
    rows.push({ date, description, amount, raw: cells });
  }
  return { rows, skipped };
}

/**
 * Match statement lines to receipt expenses on date + absolute amount,
 * scored by merchant-token overlap with the statement description. Purely
 * read-only analysis — nothing is written, dismissed, or deleted.
 */
function reconcileStatement(
  statementCsv: string,
  expenses: Expense[],
): unknown {
  const { rows, skipped } = parseStatementRows(statementCsv);
  const receipts = expenses.filter(
    (e): e is ReceiptExpense =>
      e.type === "receipt" && Boolean(e.date) && Boolean(e.amount),
  );

  const matched: {
    line: number;
    date: string;
    description: string;
    statementAmount: string;
    expenseId: string;
    merchant: string;
    expenseAmount: string;
    confidence: "high" | "medium";
  }[] = [];
  const unmatchedLines: {
    line: number;
    date: string;
    description: string;
    amount: string;
  }[] = [];
  const matchedExpenseIds = new Set<string>();

  for (const [index, row] of rows.entries()) {
    const abs = row.amount!.abs();
    const candidates = receipts.filter(
      (e) => e.date === row.date && parseAmount(e.amount)?.abs().eq(abs),
    );
    if (candidates.length === 0) {
      unmatchedLines.push({
        line: index + 1,
        date: row.date!,
        description: row.description,
        amount: row.amount!.toFixed(2),
      });
      continue;
    }
    // Best candidate = the one with the most description-token overlap.
    const descTokens = tokensOf(row.description);
    const scored = candidates
      .map((e) => {
        const overlap = [...tokensOf(e.merchant)].filter((t) =>
          descTokens.has(t),
        ).length;
        return { e, overlap };
      })
      .sort((a, b) => b.overlap - a.overlap);
    const best = scored[0]!;
    matchedExpenseIds.add(best.e.id);
    matched.push({
      line: index + 1,
      date: row.date!,
      description: row.description,
      statementAmount: row.amount!.toFixed(2),
      expenseId: best.e.id,
      merchant: best.e.merchant || "(no merchant)",
      expenseAmount: best.e.amount,
      confidence: best.overlap >= 1 ? "high" : "medium",
    });
  }

  const unmatchedExpenses = receipts
    .filter((e) => !matchedExpenseIds.has(e.id))
    .map((e) => ({
      id: e.id,
      date: e.date,
      merchant: e.merchant || "(no merchant)",
      amount: e.amount,
    }));

  return {
    statementLines: rows.length,
    matched: matched.length,
    matchedPairs: matched,
    unmatchedLines,
    unmatchedExpenses,
    skippedLines: skipped,
    note: "Reconciliation is read-only — it never writes or dismisses anything.",
  };
}
