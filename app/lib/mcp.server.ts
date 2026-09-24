import { randomBytes } from "node:crypto";
import type { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import {
  readExpenseSummary,
  readExpensesPage,
} from "~/lib/expense-read.server";
import {
  expenseFilterSchema,
  expenseSummaryOutputSchema,
  listExpensesInputSchema,
  listExpensesOutputSchema,
  listReportsOutputSchema,
  READ_TOOLS,
} from "~/lib/expense-read-tools";
import {
  MCP_SERVER_DESCRIPTION,
  MCP_SERVER_NAME,
  MCP_SERVER_TITLE,
  MCP_SERVER_VERSION,
  MCP_SERVER_WEBSITE_URL,
} from "~/lib/mcp-discovery.server";
import { ok, fail, captureReceipt, logMileage } from "~/lib/mcp-write.server";
import {
  isOAuthToken,
  issueTokenPair,
  publicOrigin,
  verifyAccessToken,
} from "~/lib/oauth.server";
import { findUserById, readBootstrapUser } from "~/lib/db/accounts";
import { readCategories } from "~/lib/db/categories";
import {
  readExpense,
  readExpenses,
  readPriorMerchants,
  upsertExpense,
} from "~/lib/db/expenses";
import { readLocations } from "~/lib/db/locations";
import { deleteOAuthClient, registerOAuthClient } from "~/lib/db/oauth";
import {
  addReport,
  findOpenReport,
  readReportSummaries,
  reportExists,
  setReportClosed,
} from "~/lib/db/reports";
import { readMileageRates } from "~/lib/db/seed";
import { readSettings } from "~/lib/db/settings";
import { renameImageToConvention } from "~/lib/images.server";
import { MAX_TRIP_STOPS } from "~/lib/maps.server";
import { reconcileForMcp } from "~/lib/reconcile.server";
import { buildReportPdf } from "~/lib/report-pdf.server";
import type { Expense } from "~/lib/types";

/**
 * The MCP server for the expense tracker: the agent-facing window onto the
 * same store the web app uses (POST /mcp, bearer-token auth).
 *
 * Tool design principle: expose capabilities, not CRUD. The flagship tool,
 * capture_receipt, runs the app's own extraction pipeline (DeepSeek /
 * tesseract + the account's merchant→category memory) so an agent can drop
 * a receipt photo/PDF and get a filed expense, the same work the web UI
 * does, without a form.
 *
 * Transport: MCP Streamable HTTP via the v2 SDK's `createMcpHandler`, one
 * endpoint, both protocol eras. 2025-era clients (the `initialize`
 * handshake) are served per request without sessions (the default
 * `legacy: 'stateless'` posture), and 2026-07-28 stateless clients (a
 * per-request `_meta` envelope) are served natively. Responses are
 * JSON-only (`responseMode: 'json'`), with no long-lived SSE streams, which
 * keeps serverless functions from holding a connection open.
 *
 * Auth is OAuth-only: every request carries an OAuth access token
 * (authorization-code flow, see oauth.server.ts). The token resolves to an
 * account before the handler runs, and each request gets a fresh server
 * instance bound to that account, so the endpoint is fully stateless, holds
 * nothing between requests, and cold starts cost nothing.
 */

// --- HTTP handling ---------------------------------------------------------

/** The three read tools, described once in the shared contract module; the
 * WebMCP client registers the same three from the same specs. */
const [LIST_EXPENSES_SPEC, EXPENSE_SUMMARY_SPEC, LIST_REPORTS_SPEC] =
  READ_TOOLS;

/** Build the per-request server instance for the authenticated account. */
async function buildServer(accountId: string): Promise<McpServer> {
  return createMcpServer(accountId);
}

/**
 * The 2026-07-28 leg: `createMcpHandler` builds a fresh server per request
 * and holds nothing between requests. `legacy: 'reject'` sends 2025-era
 * traffic to `serveLegacy` below, never here.
 */
let modernHandlerPromise: Promise<ReturnType<typeof createMcpHandler>> | null =
  null;

/** Build the strict handler on first /mcp request: the SDK is a large
 * eager-graph dependency and MCP traffic is rare. A failed import is not
 * cached: `??=` would otherwise hand the same rejection to every later
 * request until the process recycles. */
function getModernHandler(): Promise<ReturnType<typeof createMcpHandler>> {
  modernHandlerPromise ??= import("@modelcontextprotocol/server")
    .then(({ createMcpHandler }) =>
      createMcpHandler(
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
      ),
    )
    .catch((err) => {
      modernHandlerPromise = null;
      throw err;
    });
  return modernHandlerPromise;
}

/**
 * The 2025-era leg: one stateless transport per request (no session id
 * generator), with `enableJsonResponse` so responses are plain JSON instead
 * of SSE, which is simpler for CLI agents and tests and keeps serverless
 * from holding a stream open. The built-in `legacy: 'stateless'` fallback
 * does not expose that option, so the leg is wired by hand with the SDK's
 * own `isLegacyRequest` classification, the documented pattern for keeping
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
  const { WebStandardStreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/server");
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = await buildServer(auth.accountId);
  await server.connect(transport);
  return transport.handleRequest(request, { authInfo: authInfoFor(auth) });
}

/** The auth info both protocol legs pass to the SDK: the token plus the
 * resolved account. The SDK routes tool calls through these fields. */
function authInfoFor(auth: {
  accountId: string;
  userId: string;
  token: string;
}): {
  token: string;
  clientId: string;
  scopes: [];
  extra: { accountId: string };
} {
  return {
    token: auth.token,
    clientId: auth.userId,
    scopes: [],
    extra: { accountId: auth.accountId },
  };
}

/**
 * Handle any request to /mcp: authenticate the bearer token, then route by
 * protocol era: 2025-era (no `_meta` envelope claim) to the stateless
 * legacy leg, everything else to the strict 2026-07-28 handler. Loaders and
 * actions both land here.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  const { isLegacyRequest } = await import("@modelcontextprotocol/server");
  if (await isLegacyRequest(request)) return serveLegacy(request, auth);
  return (await getModernHandler()).fetch(request, {
    authInfo: authInfoFor(auth),
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

/** Cap on the reconcile tool's statement text, in characters. The model
 * names this string, so it is untrusted input: the cap refuses an oversized
 * argument before the parser walks it. A year of a busy account is a few
 * hundred KB. */
const MAX_STATEMENT_CHARS = 2_000_000;

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
        // The path-aware URL (RFC 9728 §3.1) for this endpoint's metadata:
        // the resource is /mcp, so its document sits under the well-known
        // prefix with the same path. Clients that follow the hint land on
        // the document whose `resource` matches what they are calling.
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      },
    },
  );
}

// --- Server + tools --------------------------------------------------------

/** Cross-cutting rules, served as the server's `instructions`: a 2025-era
 * client reads them from `initialize`, a 2026-07-28 one from
 * `server/discover`. They used to be repeated in each tool's own text, so
 * a tool description now only carries what is specific to that tool. */
const SERVER_INSTRUCTIONS = [
  'Amounts are decimal strings, e.g. "42.50".',
  "A report named in a tool call must already exist and be open; list_reports shows them.",
  "Where a tool takes an optional date (YYYY-MM-DD), omitting it dates the entry today in UTC, the server's clock: the response carries serverUtcNow, so compute the user's local date from it (a PST evening is already tomorrow in UTC) and pass an explicit date when the two differ.",
].join(" ");

/** An optional ISO (YYYY-MM-DD) date field on the write tools. Not a bare
 * string: a malformed date would otherwise be stored as typed and compared
 * as text against every other date. */
const isoDateField = z.iso.date().optional();

// --- Tool response schemas -------------------------------------------------
//
// The response contract of every tool: registered as `outputSchema` and
// returned as `structuredContent` by ok() in mcp-write.server.ts. The SDK
// validates a result against the schema on every success and refuses a tool
// that declares one without returning it, so the two have to move together.
// A non-object root (the list tools' arrays) is fine: a 2025-era client gets
// the SEP-2106 `{ result: … }` wrap, in its tools/list schema and in the
// result alike, from the SDK.

/** What the extraction pipeline read off a receipt, as captureReceipt
 * reports it: the fields that function copies out of ExtractionResult. Null
 * in a capture result means extraction failed and the image was filed
 * without it. */
const extractionSchema = z.object({
  isReceipt: z.boolean(),
  merchant: z.string(),
  amount: z.string(),
  currency: z.string(),
  category: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string(),
});

/** capture_receipt: the filed receipt, or the duplicate report when those
 * image bytes were already an expense. */
const captureReceiptOutputSchema = z.object({
  captured: z.boolean().describe("False when the image was already filed."),
  serverUtcNow: z.string().describe("The server clock, ISO instant."),
  expenseId: z.string().optional(),
  duplicate: z.boolean().optional(),
  duplicateOf: z.string().nullable().optional(),
  extracted: extractionSchema.nullable().optional(),
  resolved: z
    .object({
      merchant: z.string(),
      amount: z.string(),
      category: z.string(),
      date: z.string(),
      report: z.string(),
    })
    .optional(),
  fx: z
    .object({
      currency: z.string(),
      originalAmount: z.string(),
      amount: z.string(),
      fxRate: z.string(),
      rateDate: z.string(),
    })
    .optional(),
  warning: z.string().optional(),
});

/** log_mileage: the trip as filed, priced at the rate for its date and type. */
const logMileageOutputSchema = z.object({
  logged: z.boolean(),
  expenseId: z.string(),
  stops: z.array(z.string()),
  distanceMiles: z.string(),
  amount: z.string(),
  type: z.enum(["business", "charity", "medical", "moving"]),
  rate: z.string().nullable().describe("IRS rate used, null if none."),
  approximate: z.boolean().describe("Distance is straight-line, not routed."),
  roundTrip: z.boolean(),
  note: z.string().optional(),
});

const createReportOutputSchema = z.object({ name: z.string() });

const closeReportOutputSchema = z.object({
  name: z.string(),
  closed: z.boolean(),
});

const addToReportOutputSchema = z.object({
  expenseId: z.string(),
  report: z.string(),
});

/** export_report: the rendered PDF, base64 in the text block. */
const exportReportOutputSchema = z.object({
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number(),
  base64: z.string(),
  note: z.string(),
});

/** list_categories and list_merchants: a flat list of names. */
const listNamesOutputSchema = z.array(z.string());

/** get_settings: the home address, the named places, and the IRS rate table. */
const getSettingsOutputSchema = z.object({
  mileageRates: z.array(
    z.object({
      type: z.enum(["business", "charity", "medical", "moving"]),
      startDate: z.string(),
      endDate: z.string(),
      rate: z.string(),
    }),
  ),
  homeAddress: z.string(),
  locations: z.array(z.object({ name: z.string(), address: z.string() })),
});

/** reconcile: the lines that matched, the ones to review, and the receipts
 * no line claimed. Read-only, nothing is written or dismissed. */
const reconcileOutputSchema = z.object({
  statementLines: z.number(),
  matched: z.number(),
  matchedPairs: z.array(
    z.object({
      line: z.number(),
      date: z.string(),
      description: z.string(),
      statementAmount: z.string(),
      expenseId: z.string(),
      merchant: z.string(),
      expenseAmount: z.string(),
      confidence: z.literal("high"),
    }),
  ),
  needsReview: z.array(
    z.object({
      line: z.number(),
      date: z.string(),
      description: z.string(),
      statementAmount: z.string(),
      reasons: z.array(z.string()),
      candidates: z.array(
        z.object({
          expenseId: z.string(),
          merchant: z.string(),
          expenseAmount: z.string(),
        }),
      ),
    }),
  ),
  unmatchedLines: z.array(
    z.object({
      line: z.number(),
      date: z.string(),
      description: z.string(),
      amount: z.string(),
    }),
  ),
  unmatchedExpenses: z.array(
    z.object({
      id: z.string(),
      date: z.string(),
      merchant: z.string(),
      amount: z.string(),
    }),
  ),
  skippedLines: z.array(
    z.object({
      line: z.number(),
      raw: z.string(),
      reason: z.string(),
    }),
  ),
  note: z.string(),
});

/** The tools a healthy server must expose; the deployed-bundle check. */
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
 * trips through `handleMcpRequest` (the exact code /mcp serves) in BOTH
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

    /** tools/call get_settings must answer with a non-error result, in both
     * halves: the text block, and the structuredContent its outputSchema
     * describes (the SDK validated it, so this checks the data landed). */
    const callSettings = async (
      body: Record<string, unknown>,
      label: string,
      extraHeaders: Record<string, string> = {},
    ): Promise<void> => {
      const result = await assertResult(
        await post(body, {
          ...extraHeaders,
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
      const structured = result.structuredContent;
      const hasRates =
        structured !== null &&
        typeof structured === "object" &&
        "mileageRates" in structured &&
        Array.isArray(structured.mileageRates);
      if (!hasRates) {
        throw new Error(
          `${label} get_settings returned no structured settings`,
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
    // The 2026-07-28 leg names its revision twice: in the body envelope and in
    // the MCP-Protocol-Version header. The transport rejects a request whose
    // header and body disagree ("the required MCP-Protocol-Version header is
    // absent"), so every modern request below carries this.
    const modernHeaders: Record<string, string> = {
      "MCP-Protocol-Version": "2026-07-28",
    };
    await assertResult(
      await post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: envelope },
        },
        { ...modernHeaders, "Mcp-Method": "server/discover" },
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
          { ...modernHeaders, "Mcp-Method": "tools/list" },
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
      modernHeaders,
    );

    return { tools: modernNames.length, ms: Date.now() - started };
  } finally {
    // Always clean up: the throwaway client (cascades its tokens).
    await deleteOAuthClient(clientId);
  }
}

async function createMcpServer(accountId: string): Promise<McpServer> {
  const { McpServer } = await import("@modelcontextprotocol/server");
  // The identity the Server Card declares (app/lib/mcp-discovery.server.ts),
  // so the live serverInfo cannot drift from the published card.
  //
  // The Sentry wrapper has to be applied to the instance *before* the tools
  // are registered, so it patches `registerTool` itself; it reads the same
  // `_registeredTools` field this SDK version keeps. Tool arguments and
  // results stay out of Sentry on purpose: a receipt arrives as base64 image
  // bytes and a statement as the customer's own bank rows.
  const server = Sentry.wrapMcpServerWithSentry(
    // Two arguments, not one: serverInfo (the identity the Server Card
    // publishes) and the options, which is where `instructions` lives. Passing
    // them in a single object drops the type check that keeps the two apart and
    // buries the instructions inside serverInfo, where a client does not read
    // them.
    new McpServer(
      {
        name: MCP_SERVER_NAME,
        title: MCP_SERVER_TITLE,
        version: MCP_SERVER_VERSION,
        description: MCP_SERVER_DESCRIPTION,
        websiteUrl: MCP_SERVER_WEBSITE_URL,
      },
      { instructions: SERVER_INSTRUCTIONS },
    ),
    { recordInputs: false, recordOutputs: false },
  );

  // --- capture_receipt -----------------------------------------------------

  server.registerTool(
    "capture_receipt",
    {
      annotations: { destructiveHint: false },
      description:
        "Capture a receipt from a base64 image/PDF or a URL: extract the merchant, amount and category (reusing the merchant's previous category when known), store the image, and create the expense. A non-USD amount is converted to USD at the ECB reference rate for the expense date. Returns the extracted fields and the new expense id.",
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
            'Amount as a decimal string in `currency`, e.g. "42.50" (otherwise extracted).',
          ),
        currency: z
          .string()
          .optional()
          .describe(
            'ISO 4217 code of the amount\'s currency, e.g. "EUR". Defaults to the currency extracted from the receipt, else USD. A non-USD amount is stored as its USD conversion.',
          ),
        category: z
          .string()
          .optional()
          .describe(
            "Category override (otherwise resolved from the merchant's history, then the extraction suggestion).",
          ),
        date: isoDateField.describe(
          "Expense date YYYY-MM-DD. Omitted dates the expense today in UTC, per the server instructions.",
        ),
        report: z.string().optional().describe("Report name to file under."),
        description: z.string().optional().describe("Description or memo."),
      }),
      outputSchema: captureReceiptOutputSchema,
    },
    async (args) => {
      return captureReceipt(accountId, args);
    },
  );

  // --- log_mileage ---------------------------------------------------------

  server.registerTool(
    "log_mileage",
    {
      annotations: { destructiveHint: false },
      description:
        "Log a driving trip: geocode the stops, compute the route distance and the amount at the IRS rate for the trip's date and type, and create the mileage expense. The trip runs one way, from the first stop to the last; pass roundTrip true when the drive returns to its first stop.",
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
          .max(MAX_TRIP_STOPS)
          .describe(
            "Ordered trip stops: start, intermediate stops, end. Each is an address string or a pre-geocoded { address, lat, lng }.",
          ),
        date: isoDateField.describe(
          "Trip date YYYY-MM-DD. Omitted dates the trip today in UTC, per the server instructions.",
        ),
        type: z
          .enum(["business", "charity", "medical", "moving"])
          .optional()
          .describe(
            "IRS trip type — picks the rate for the trip's date (defaults to business).",
          ),
        report: z.string().optional().describe("Report name to file under."),
        category: z.string().optional().describe("Category name."),
        description: z.string().optional().describe("Description or memo."),
        roundTrip: z
          .boolean()
          .optional()
          .describe(
            "One way by default: the trip starts at the first stop and ends at the last. Pass true when the drive returns to the first stop (a closed loop), which roughly doubles the distance for a there-and-back pair.",
          ),
      }),
      outputSchema: logMileageOutputSchema,
    },
    async (args) => {
      return logMileage(accountId, args);
    },
  );

  // --- list_expenses / expense_summary / list_reports ----------------------

  // The three read tools are thin adapters over the shared implementations
  // in expense-read.server.ts, validating with the shared zod schemas from
  // expense-read-tools.ts. The same schemas and implementations back the
  // WebMCP in-page tools, so both surfaces stay identical.
  server.registerTool(
    LIST_EXPENSES_SPEC.name,
    {
      annotations: { readOnlyHint: true },
      description: LIST_EXPENSES_SPEC.description,
      inputSchema: listExpensesInputSchema,
      outputSchema: listExpensesOutputSchema,
    },
    async ({ limit, ...filters }) => {
      return ok(await readExpensesPage(accountId, filters, limit));
    },
  );

  server.registerTool(
    EXPENSE_SUMMARY_SPEC.name,
    {
      annotations: { readOnlyHint: true },
      description: EXPENSE_SUMMARY_SPEC.description,
      inputSchema: expenseFilterSchema,
      outputSchema: expenseSummaryOutputSchema,
    },
    async (args) => {
      return ok(await readExpenseSummary(accountId, args));
    },
  );

  server.registerTool(
    LIST_REPORTS_SPEC.name,
    {
      annotations: { readOnlyHint: true },
      description: LIST_REPORTS_SPEC.description,
      inputSchema: z.object({}),
      outputSchema: listReportsOutputSchema,
    },
    async () => {
      return ok(await readReportSummaries(accountId));
    },
  );

  // --- create_report / close_report / add_to_report ------------------------

  server.registerTool(
    "create_report",
    {
      annotations: { destructiveHint: false },
      description:
        'Create a report (e.g. "Q3 2026") to group expenses. Fails if the name already exists.',
      inputSchema: z.object({
        name: z.string().min(1).describe("Report name."),
      }),
      outputSchema: createReportOutputSchema,
    },
    async ({ name }) => {
      const result = await addReport(accountId, name);
      return result.ok ? ok({ name }) : fail(result.error);
    },
  );

  server.registerTool(
    "close_report",
    {
      annotations: { destructiveHint: false, idempotentHint: true },
      description:
        "Close (or reopen) a report. Closed reports refuse new expenses.",
      inputSchema: z.object({
        name: z.string().min(1),
        closed: z.boolean().optional().describe("Default true."),
      }),
      outputSchema: closeReportOutputSchema,
    },
    async ({ name, closed }) => {
      await setReportClosed(accountId, name, closed ?? true);
      return ok({ name, closed: closed ?? true });
    },
  );

  server.registerTool(
    "add_to_report",
    {
      annotations: { idempotentHint: true },
      description:
        "Move an expense into a report. Also renames the stored receipt image to the dated convention name when the expense has a date and original filename.",
      inputSchema: z.object({
        expenseId: z.string().min(1),
        report: z.string().min(1).describe("Report name."),
      }),
      outputSchema: addToReportOutputSchema,
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
      annotations: { readOnlyHint: true },
      description:
        "Render a report as a PDF (the same layout as the web export: grouped by category, mileage rows with type/rate/distance, and a 'Receipts & routes' appendix — receipt images plus a real route map per mileage trip with its date, mileage, and amount listed beside it) and return it base64-encoded. Decode and save as a .pdf file.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Report name."),
      }),
      outputSchema: exportReportOutputSchema,
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
      annotations: { readOnlyHint: true },
      description:
        "The account's category names (alphabetical) — use these when categorizing expenses.",
      inputSchema: z.object({}),
      outputSchema: listNamesOutputSchema,
    },
    async () => {
      const categories = await readCategories(accountId);
      return ok(categories.map((c) => c.name));
    },
  );

  server.registerTool(
    "list_merchants",
    {
      annotations: { readOnlyHint: true },
      description: "Merchant names previously used, most recent first.",
      inputSchema: z.object({}),
      outputSchema: listNamesOutputSchema,
    },
    async () => ok(await readPriorMerchants(accountId)),
  );

  server.registerTool(
    "get_settings",
    {
      annotations: { readOnlyHint: true },
      description:
        "Account settings: the home address (start and end of every trip), the account's named locations, and the IRS mileage-rate master table (period + type).",
      inputSchema: z.object({}),
      outputSchema: getSettingsOutputSchema,
    },
    async () => {
      const [settings, locations, rates] = await Promise.all([
        readSettings(accountId),
        readLocations(accountId),
        readMileageRates(),
      ]);
      return ok({
        mileageRates: rates,
        homeAddress: settings.homeAddress,
        locations: locations.map((l) => ({ name: l.name, address: l.address })),
      });
    },
  );

  // --- reconcile -----------------------------------------------------------

  server.registerTool(
    "reconcile",
    {
      annotations: { readOnlyHint: true },
      description:
        "Match a bank statement against logged expenses. Pass the statement as CSV or QFX/OFX text (CSV: header row optional, date/description/amount columns, signed amounts or Debit/Credit split; QFX/OFX: FITID honored). Returns matched pairs (high confidence), statement lines needing review (amount+date match but merchant differs, or ambiguous), statement lines with no matching receipt, and logged receipts with no statement line. Refund/credit lines and already-reconciled receipts are never auto-matched.",
      // The model names this string, so the schema caps it (see
      // MAX_STATEMENT_CHARS) before the parser walks it.
      inputSchema: z.object({
        statementCsv: z.string().min(1).max(MAX_STATEMENT_CHARS),
      }),
      outputSchema: reconcileOutputSchema,
    },
    async ({ statementCsv }) => {
      const expenses = await readExpenses(accountId);
      return ok(reconcileForMcp(statementCsv, expenses));
    },
  );

  return server;
}
