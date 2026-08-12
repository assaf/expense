import { randomBytes } from "node:crypto";
import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import Decimal from "decimal.js";
import {
  isOAuthToken,
  issueTokenPair,
  publicOrigin,
  verifyAccessToken,
} from "~/lib/oauth.server";
import {
  findUserById,
  readExpenses,
  readExpense,
  findOpenReport,
  reportExists,
  readReportSummaries,
  readCategories,
  readSettings,
  readMileageRates,
  readExtractionContext,
  readPriorMerchants,
  addReport,
  setReportClosed,
  upsertExpense,
  readBootstrapUser,
  registerOAuthClient,
  deleteOAuthClient,
} from "~/lib/database";
import {
  normalizeAmount,
  sortExpenses,
  summarizeBy,
  todayDate,
} from "~/lib/format";
import { validateExpenseInputs } from "~/lib/expense-save.server";
import {
  mimeForFile,
  renameImageToConvention,
  saveImage,
} from "~/lib/images.server";
import { recomputeMileage } from "~/lib/maps.server";
import { mileageRateFor } from "~/lib/mileage-rates";
import { reconcileForMcp } from "~/lib/reconcile.server";
import { resolveCategory } from "~/lib/receipt-ai.server";
import { extractFromImage } from "~/lib/receipt-ocr.server";
import { buildReportPdf } from "~/lib/report-pdf.server";
import {
  newExpenseShell,
  type Expense,
  type Location,
  type MileageExpense,
  type MileageType,
  type ReceiptExpense,
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
 * Transport: MCP Streamable HTTP via the v2 SDK's `createMcpHandler` — one
 * endpoint, both protocol eras. 2025-era clients (the `initialize`
 * handshake) are served per request without sessions (the default
 * `legacy: 'stateless'` posture), and 2026-07-28 stateless clients (a
 * per-request `_meta` envelope) are served natively. Responses are
 * JSON-only (`responseMode: 'json'`) — no long-lived SSE streams, which
 * keeps serverless functions from holding a connection open.
 *
 * Auth is OAuth-only: every request carries an OAuth access token
 * (authorization-code flow, see oauth.server.ts). The token resolves to an
 * account before the handler runs, and each request gets a fresh server
 * instance bound to that account — the endpoint is fully stateless, holds
 * nothing between requests, and cold starts cost nothing.
 */

/** The largest receipt bytes a capture tool accepts (matches a phone photo). */
const MAX_CAPTURE_BYTES = 15_000_000;

// --- HTTP handling ---------------------------------------------------------

/** Build the per-request server instance for the authenticated account. */
function buildServer(accountId: string): McpServer {
  return createMcpServer(accountId);
}

/**
 * The 2026-07-28 leg: `createMcpHandler` builds a fresh server per request
 * and holds nothing between requests. `legacy: 'reject'` — 2025-era traffic
 * is routed to `serveLegacy` below, never here.
 */
const modernHandler = createMcpHandler(
  (ctx) => {
    const accountId = ctx.authInfo?.extra?.accountId;
    if (typeof accountId !== "string") {
      // Unreachable: authenticateRequest runs before every handler.fetch.
      throw new Error("[mcp] Missing account in authInfo");
    }
    return buildServer(accountId);
  },
  {
    legacy: "reject",
    responseMode: "json",
    onerror: (error) => console.error("[mcp] %s", error.message),
  },
);

/**
 * The 2025-era leg: one stateless transport per request (no session id
 * generator), with `enableJsonResponse` so responses are plain JSON instead
 * of SSE — simpler for CLI agents and tests, and keeps serverless functions
 * from holding a stream open. The built-in `legacy: 'stateless'` fallback
 * does not expose that option, so the leg is wired by hand with the SDK's
 * own `isLegacyRequest` classification — the documented pattern for keeping
 * a legacy deployment next to a strict modern handler.
 */
async function serveLegacy(
  request: Request,
  auth: { accountId: string; userId: string; token: string },
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    // No sessions, so legacy GET (SSE stream) and DELETE are meaningless.
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      },
      { status: 405 },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildServer(auth.accountId);
  await server.connect(transport);
  return transport.handleRequest(request, {
    authInfo: {
      token: auth.token,
      clientId: auth.userId,
      scopes: [],
      extra: { accountId: auth.accountId },
    },
  });
}

/**
 * Handle any request to /mcp: authenticate the bearer token, then route by
 * protocol era — 2025-era (no `_meta` envelope claim) to the stateless
 * legacy leg, everything else to the strict 2026-07-28 handler. Loaders and
 * actions both land here.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  if (await isLegacyRequest(request)) return serveLegacy(request, auth);
  return modernHandler.fetch(request, {
    authInfo: {
      token: auth.token,
      clientId: auth.userId,
      scopes: [],
      extra: { accountId: auth.accountId },
    },
  });
}

/**
 * Validate `Authorization: Bearer …` and resolve the account. The only
 * accepted tokens are `oat_…` OAuth access tokens from the authorization-
 * code flow, which authenticate the user who signed in (their account,
 * full access). Unauthenticated requests get a 401 carrying the RFC 9728
 * protected-resource hint so OAuth-capable clients can start discovery.
 */
async function authenticateRequest(
  request: Request,
): Promise<{ accountId: string; userId: string; token: string } | Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !isOAuthToken(token)) {
    return jsonError(request, 401, MISSING_TOKEN_MESSAGE);
  }
  const verified = await verifyAccessToken(token);
  if (!verified)
    return jsonError(
      request,
      401,
      "Unknown or expired access token — sign in again.",
    );
  const user = await findUserById(verified.userId);
  if (!user) return jsonError(request, 401, "Unknown account — sign in again.");
  return { accountId: user.accountId, userId: user.id, token };
}

/** Shown when no bearer token is present or it isn't an OAuth access token. */
const MISSING_TOKEN_MESSAGE =
  "Missing bearer token — connect by signing in: point your MCP client at this endpoint and approve the connection.";

/**
 * A 401 with the OAuth protected-resource metadata hint (RFC 9728), so
 * clients that perform discovery can find the authorization server.
 */
function jsonError(
  request: Request,
  status: number,
  message: string,
): Response {
  const origin = publicOrigin(request);
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
 * Post-deploy MCP smoke check (called from GET /api/smoke): real round
 * trips through `handleMcpRequest` — the exact code /mcp serves — in BOTH
 * protocol eras: a 2025-era initialize → tools/list → tools/call flow
 * (served statelessly) and a 2026-07-28 server/discover → tools/list →
 * tools/call flow carrying the per-request `_meta` envelope and the
 * standard `Mcp-Method`/`Mcp-Name` headers. Authenticated with an OAuth
 * access token issued straight to the store (no browser needed). Proves the
 * MCP SDK + zod survived Vercel's dependency tracer in the serverless
 * bundle and that the endpoint can serve both generations of clients
 * against the real database. Throws with a message on any failure.
 */
export async function runMcpSmoke(): Promise<{ tools: number; ms: number }> {
  const user = await readBootstrapUser();
  if (!user) {
    throw new Error(
      "no account to exercise the MCP endpoint against (empty database?)",
    );
  }
  const started = Date.now();
  // A throwaway OAuth client + token pair, removed in `finally` below.
  const clientId = `smoke_${randomBytes(8).toString("hex")}`;
  await registerOAuthClient({
    id: clientId,
    secretHash: null,
    name: "smoke check",
    redirectUris: ["https://smoke.invalid/callback"],
    authMethod: "none",
  });
  const { accessToken } = await issueTokenPair(user.id, clientId);
  const token = accessToken;
  try {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      handleMcpRequest(
        new Request("http://smoke.local/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // The transport answers 406 without the spec's Accept header.
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${token}`,
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );

    /** Assert a JSON-RPC success result and return its `result`. */
    const assertResult = async (
      res: Response,
      label: string,
    ): Promise<Record<string, unknown>> => {
      if (res.status !== 200) {
        throw new Error(`MCP ${label} failed: HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        result?: Record<string, unknown>;
        error?: { message?: string };
      };
      if (!json.result) {
        throw new Error(
          `MCP ${label} returned no result: ${json.error?.message ?? JSON.stringify(json)}`,
        );
      }
      return json.result;
    };

    /** Verify every expected tool is advertised; returns the names. */
    const assertTools = (
      result: Record<string, unknown>,
      label: string,
    ): string[] => {
      const names = (
        (result.tools as { name?: string }[] | undefined) ?? []
      ).map((t) => t.name ?? "");
      for (const expected of SMOKE_TOOL_NAMES) {
        if (!names.includes(expected)) {
          throw new Error(
            `MCP tool missing from the bundle (${label}): ${expected}`,
          );
        }
      }
      return names;
    };

    /** tools/call get_settings must answer with a non-error result. */
    const callSettings = async (
      body: Record<string, unknown>,
      label: string,
    ): Promise<void> => {
      const result = await assertResult(
        await post(body, {
          "Mcp-Method": "tools/call",
          "Mcp-Name": "get_settings",
        }),
        `${label} tools/call`,
      );
      if (result.isError) {
        const content = (result as { content?: { text?: string }[] }).content;
        throw new Error(
          `${label} get_settings errored: ${content?.[0]?.text ?? "no content"}`,
        );
      }
    };

    // --- 2025-era (legacy): initialize → tools/list → tools/call -----------
    await assertResult(
      await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "smoke", version: "1.0.0" },
        },
      }),
      "legacy initialize",
    );
    assertTools(
      await assertResult(
        await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        "legacy tools/list",
      ),
      "legacy",
    );
    await callSettings(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_settings", arguments: {} },
      },
      "legacy",
    );

    // --- 2026-07-28 era (modern): discover → tools/list → tools/call -------
    const envelope = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "smoke", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    await assertResult(
      await post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: envelope },
        },
        { "Mcp-Method": "server/discover" },
      ),
      "modern server/discover",
    );
    const modernNames = assertTools(
      await assertResult(
        await post(
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: { _meta: envelope },
          },
          { "Mcp-Method": "tools/list" },
        ),
        "modern tools/list",
      ),
      "modern",
    );
    await callSettings(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { _meta: envelope, name: "get_settings", arguments: {} },
      },
      "modern",
    );

    return { tools: modernNames.length, ms: Date.now() - started };
  } finally {
    // Always clean up: the throwaway client (cascades its tokens).
    await deleteOAuthClient(clientId);
  }
}

function createMcpServer(accountId: string): McpServer {
  const server = new McpServer({ name: "expense", version: "0.1.0" });

  // --- capture_receipt -----------------------------------------------------

  server.registerTool(
    "capture_receipt",
    {
      description:
        "Capture a receipt from a base64 image/PDF or a URL: extract the merchant, amount and category (reusing the merchant's previous category when known), store the image, and create the expense. Returns the extracted fields and the new expense id.",
      inputSchema: z.object({
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
          .describe(
            "Report name to file under; must already exist and be open.",
          ),
        description: z.string().optional().describe("Description or memo."),
      }),
    },
    async (args) => {
      return captureReceipt(accountId, args);
    },
  );

  // --- log_mileage ---------------------------------------------------------

  server.registerTool(
    "log_mileage",
    {
      description:
        "Log a driving trip: geocode the stops, compute the route distance and the amount at the IRS rate for the trip's date and type, and create the mileage expense.",
      inputSchema: z.object({
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
        type: z
          .enum(["business", "charity", "medical", "moving"])
          .optional()
          .describe(
            "IRS trip type — picks the rate for the trip's date (defaults to business).",
          ),
        report: z
          .string()
          .optional()
          .describe(
            "Report name to file under; must already exist and be open.",
          ),
        category: z.string().optional().describe("Category name."),
        description: z.string().optional().describe("Description or memo."),
      }),
    },
    async (args) => {
      return logMileage(accountId, args);
    },
  );

  // --- list_expenses -------------------------------------------------------

  server.registerTool(
    "list_expenses",
    {
      description:
        "Query expenses with optional filters (date range, category, merchant, report, unreported-only, type). Returns newest first. Amounts are decimal strings.",
      inputSchema: z.object({
        dateFrom: z
          .string()
          .optional()
          .describe("Inclusive start date YYYY-MM-DD."),
        dateTo: z
          .string()
          .optional()
          .describe("Inclusive end date YYYY-MM-DD."),
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
      }),
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

  server.registerTool(
    "expense_summary",
    {
      description:
        'Totals for expenses matching the filters: overall count + sum, and per-category breakdown. The answer to "how much did I spend on X?".',
      inputSchema: z.object({
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        category: z.string().optional(),
        merchant: z.string().optional(),
        report: z.string().optional(),
        unreported: z.boolean().optional(),
        type: z.enum(["receipt", "mileage"]).optional(),
      }),
    },
    async (args) => {
      const expenses = filterExpenses(await readExpenses(accountId), args);
      const byCategory = summarizeBy(
        expenses,
        (e) => e.category || "Uncategorized",
      );
      // The grand total is the exact sum of the category buckets — every
      // amount-bearing expense lands in exactly one bucket.
      const total = [...byCategory.values()].reduce(
        (sum, b) => sum.add(b.total),
        new Decimal(0),
      );
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

  server.registerTool(
    "list_reports",
    {
      description: "All reports with their expense counts and exact totals.",
      inputSchema: z.object({}),
    },
    async () => {
      return ok(await readReportSummaries(accountId));
    },
  );

  // --- create_report / close_report / add_to_report ------------------------

  server.registerTool(
    "create_report",
    {
      description:
        'Create a report (e.g. "Q3 2026") to group expenses. Fails if the name already exists.',
      inputSchema: z.object({
        name: z.string().min(1).describe("Report name."),
      }),
    },
    async ({ name }) => {
      const result = await addReport(accountId, name);
      return result.ok ? ok({ name }) : fail(result.error);
    },
  );

  server.registerTool(
    "close_report",
    {
      description:
        "Close (or reopen) a report. Closed reports refuse new expenses.",
      inputSchema: z.object({
        name: z.string().min(1),
        closed: z.boolean().optional().describe("Default true."),
      }),
    },
    async ({ name, closed }) => {
      await setReportClosed(accountId, name, closed ?? true);
      return ok({ name, closed: closed ?? true });
    },
  );

  server.registerTool(
    "add_to_report",
    {
      description:
        "Move an expense into a report (must exist and be open). Also renames the stored receipt image to the dated convention name when the expense has a date and original filename.",
      inputSchema: z.object({
        expenseId: z.string().min(1),
        report: z.string().min(1).describe("Existing, open report name."),
      }),
    },
    async ({ expenseId, report }) => {
      const expense = await readExpense(expenseId, accountId);
      if (!expense) return fail(`No expense with id "${expenseId}".`);
      const { error } = await findOpenReport(accountId, report);
      if (error) return fail(error);
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

  server.registerTool(
    "export_report",
    {
      description:
        "Render a report as a PDF (the same layout as the web export: grouped by category, mileage rows with type/rate/distance, and a 'Receipts & routes' appendix — receipt images plus a real route map per mileage trip with its date, mileage, and amount listed beside it) and return it base64-encoded. Decode and save as a .pdf file.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Report name."),
      }),
    },
    async ({ name }) => {
      if (!(await reportExists(accountId, name))) {
        return fail(`Report "${name}" doesn't exist.`);
      }
      const pdf = await buildReportPdf(
        accountId,
        name,
        await readExpenses(accountId),
        await readMileageRates(),
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

  server.registerTool(
    "list_categories",
    {
      description:
        "The account's category names (alphabetical) — use these when categorizing expenses.",
      inputSchema: z.object({}),
    },
    async () => {
      const categories = await readCategories(accountId);
      return ok(categories.map((c) => c.name));
    },
  );

  server.registerTool(
    "list_merchants",
    {
      description: "Merchant names previously used, most recent first.",
      inputSchema: z.object({}),
    },
    async () => ok(await readPriorMerchants(accountId)),
  );

  server.registerTool(
    "get_settings",
    {
      description:
        "Account settings: the home address and the IRS mileage-rate master table (period + type).",
      inputSchema: z.object({}),
    },
    async () => {
      const [settings, rates] = await Promise.all([
        readSettings(accountId),
        readMileageRates(),
      ]);
      return ok({
        mileageRates: rates,
        homeAddress: settings.homeAddress,
      });
    },
  );

  // --- reconcile -----------------------------------------------------------

  server.registerTool(
    "reconcile",
    {
      description:
        "Match a bank statement against logged expenses. Pass the statement as CSV or QFX/OFX text (CSV: header row optional, date/description/amount columns, signed amounts or Debit/Credit split; QFX/OFX: FITID honored). Returns matched pairs (high confidence), statement lines needing review (amount+date match but merchant differs, or ambiguous), statement lines with no matching receipt, and logged receipts with no statement line. Refund/credit lines and already-reconciled receipts are never auto-matched.",
      inputSchema: z.object({ statementCsv: z.string().min(1) }),
    },
    async ({ statementCsv }) => {
      const expenses = await readExpenses(accountId);
      return ok(reconcileForMcp(statementCsv, expenses));
    },
  );

  return server;
}

// --- Tool implementations --------------------------------------------------

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
          mileageType: e.mileageType,
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
    mime = args.mime?.trim() || mimeForFile(args.filename ?? "") || "image/png";
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
      mimeForFile(fromUrl) ||
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
  const report = args.report?.trim() ?? "";
  const inputError = await validateExpenseInputs(accountId, date, report);
  if (inputError) return fail(inputError);

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
    type?: MileageType;
    report?: string;
    category?: string;
    description?: string;
  },
): Promise<ToolResult> {
  const date = args.date ?? todayDate();
  const report = args.report?.trim() ?? "";
  const inputError = await validateExpenseInputs(accountId, date, report);
  if (inputError) return fail(inputError);

  const stops: Location[] = args.locations.map((l) =>
    typeof l === "string"
      ? { address: l, lat: null, lng: null }
      : { address: l.address, lat: l.lat ?? null, lng: l.lng ?? null },
  );
  if (stops.filter((s) => s.address.trim() !== "").length < 2) {
    return fail("A trip needs at least two stops.");
  }

  // The IRS rate for the trip's (date, type) — no rate in the master table
  // for the period means no amount (never $0.00).
  const rate = mileageRateFor(
    await readMileageRates(),
    date,
    args.type ?? "business",
  );
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
    mileageType: args.type ?? "business",
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
    type: expense.mileageType,
    rate: rate || null,
    approximate,
    ...(approximate
      ? {
          note: "Route service unavailable — distance is straight-line; re-save the expense later to recompute.",
        }
      : {}),
  });
}

function urlFilename(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ?? "";
  } catch {
    return "";
  }
}
