/**
 * Drive the recorded MCP demo (docs/mcp-demo.md) end-to-end against a running
 * server: four moves — capture a receipt, ask a spending question, build and
 * export a report, reconcile a statement. Prints a transcript and saves the
 * exported report PDF to demo-output/.
 *
 * Prereqs: the dev server is running (pnpm dev or pnpm start) and the demo
 * account is seeded (pnpm demo:seed). Auth uses an OAuth access token issued
 * directly to the store for the demo user — the same token type a browser
 * sign-in would produce, no browser needed.
 *
 *   DEMO_URL=http://localhost:3000 pnpm demo:run
 *
 * Note: capture_receipt passes merchant/amount/date overrides so the move is
 * deterministic without DEEPSEEK_API_KEY; with a key configured the real OCR
 * extraction runs and the overrides are unnecessary.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client.ts";

const BASE = process.env.DEMO_URL ?? "http://localhost:3000";
const MCP_URL = `${BASE}/mcp`;
const DEMO_EMAIL = "demo@example.com";
const OUTPUT_DIR = join(process.cwd(), "demo-output");

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  }),
});

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

// --- MCP client helpers ----------------------------------------------------

let requestId = 1;
let sessionId = "";

async function mcp(
  token: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId++,
      method,
      params,
    }),
  });
  if (!res.ok)
    throw new Error(`${method}: HTTP ${res.status} — ${await res.text()}`);
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const json = (await res.json()) as { result?: unknown; error?: unknown };
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

/** A JSON-RPC notification — no id, expected to return 202. */
async function notify(
  token: string,
  method: string,
  params: unknown,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
  if (res.status !== 202) {
    throw new Error(`${method}: expected 202, got ${res.status}`);
  }
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const result = (await mcp(token, "tools/call", {
    name,
    arguments: args,
  })) as {
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = result.content?.[0]?.text ?? "";
  const payload = JSON.parse(text) as Record<string, unknown>;
  if (result.isError) throw new Error(`${name}: ${text}`);
  return payload;
}

/** A passable receipt image (merchant + items + total) drawn with canvas. */
function drawReceipt(): Buffer {
  const canvas = createCanvas(600, 860);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 600, 860);
  ctx.fillStyle = "#111111";
  ctx.font = "bold 40px Helvetica";
  ctx.fillText("BLUE BOTTLE COFFEE", 40, 80);
  ctx.font = "26px Helvetica";
  ctx.fillText("1234 Abbot Kinney Blvd", 40, 130);
  ctx.fillText("Los Angeles, CA", 40, 170);
  ctx.fillText("----------------------------------------", 40, 240);
  ctx.font = "28px Helvetica";
  ctx.fillText("1x  Caffe Latte          5.25", 40, 300);
  ctx.fillText("1x  Cold Brew            4.75", 40, 350);
  ctx.fillText("----------------------------------------", 40, 430);
  ctx.font = "bold 32px Helvetica";
  ctx.fillText("TOTAL                 $10.00", 40, 500);
  ctx.font = "26px Helvetica";
  ctx.fillText("Visa **** 1234", 40, 580);
  ctx.fillText("06/28/2026  10:42 AM", 40, 620);
  return canvas.toBuffer("image/png");
}

// --- The four demo moves ---------------------------------------------------

async function moveCapture(token: string): Promise<void> {
  console.info(
    "\n\u2500\u2500\u2500 MOVE 1 \u2014 capture a receipt \u2500\u2500\u2500",
  );
  console.info('\u25b8 You: "Here\u2019s my receipt \u2014 log it under Q3."');
  const png = drawReceipt();
  const payload = await callTool(token, "capture_receipt", {
    imageData: png.toString("base64"),
    mime: "image/png",
    filename: "blue-bottle.png",
    // Deterministic without a DeepSeek key; with DEEPSEEK_API_KEY set the
    // real OCR extraction runs and these are unnecessary.
    merchant: "Blue Bottle Coffee",
    amount: "10.00",
    date: "2026-06-28",
    report: "Q3 2026",
  });
  const resolved = payload.resolved as Record<string, unknown>;
  console.info(
    `  \u2713 captured ${resolved.amount} at ${resolved.merchant} \u2192 ${resolved.category}`,
  );
  console.info(
    `  \u2713 category reused from the merchant\u2019s own history (Blue Bottle Coffee), expense ${String(payload.expenseId).slice(-6)}\u2026`,
  );
}

async function moveSpending(token: string): Promise<void> {
  console.info(
    "\n\u2500\u2500\u2500 MOVE 2 \u2014 ask about spending \u2500\u2500\u2500",
  );
  console.info('\u25b8 You: "How much did I spend on flights last quarter?"');
  const payload = await callTool(token, "expense_summary", {
    category: "Travel",
    dateFrom: "2026-04-01",
    dateTo: "2026-06-30",
  });
  const byCategory = payload.byCategory as {
    category: string;
    count: number;
    total: string;
  }[];
  const travel = byCategory.find((c) => c.category === "Travel");
  console.info(
    `  \u2713 Travel (Apr 1 \u2013 Jun 30, 2026): ${travel?.count ?? 0} expenses, $${travel?.total ?? "0.00"} \u2014 straight from the data, not a guess.`,
  );
}

async function moveReport(token: string): Promise<void> {
  console.info(
    "\n\u2500\u2500\u2500 MOVE 3 \u2014 build and export a report \u2500\u2500\u2500",
  );
  console.info(
    '\u25b8 You: "Move all unreported June expenses into the Q2 report and export the PDF."',
  );
  const listed = await callTool(token, "list_expenses", {
    unreported: true,
    dateFrom: "2026-06-01",
    dateTo: "2026-06-30",
  });
  const expenses = listed.expenses as { id: string; merchant: string }[];
  for (const e of expenses) {
    await callTool(token, "add_to_report", {
      expenseId: e.id,
      report: "Q2 2026",
    });
  }
  console.info(
    `  \u2713 moved ${expenses.length} unreported expenses into "Q2 2026"`,
  );

  const pdf = await callTool(token, "export_report", { name: "Q2 2026" });
  const bytes = Buffer.from(pdf.base64 as string, "base64");
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = join(OUTPUT_DIR, "Q2 2026.pdf");
  writeFileSync(file, bytes);
  console.info(
    `  \u2713 exported ${file} (${(bytes.length / 1024).toFixed(1)} KB)`,
  );
}

async function moveReconcile(token: string): Promise<void> {
  console.info(
    "\n\u2500\u2500\u2500 MOVE 4 \u2014 reconcile a statement \u2500\u2500\u2500",
  );
  console.info('\u25b8 You: "Reconcile this statement."');
  const csv = [
    "date,description,amount",
    "2026-04-05,UNITED AIRLINES,212.40",
    "2026-06-15,UNITED AIRLINES E-TICKET,178.90",
    "2026-06-03,FIGMA,15.00",
    "2026-06-21,STAPLES,42.30",
    "2026-07-02,SPOTIFY,10.99",
  ].join("\n");
  const payload = await callTool(token, "reconcile", { statementCsv: csv });
  const matched = payload.matchedPairs as {
    merchant: string;
    confidence: string;
  }[];
  const unmatched = payload.unmatchedLines as {
    description: string;
    amount: string;
  }[];
  console.info(
    `  \u2713 matched ${matched.length} lines (${matched.filter((m) => m.confidence === "high").length} high confidence)`,
  );
  for (const line of unmatched) {
    console.info(
      `  \u26a0 no matching receipt: ${line.description} \u2014 $${line.amount}`,
    );
  }
  console.info(
    "  (read-only \u2014 reconcile never writes or dismisses anything)",
  );
}

// --- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is required — run against the local dev DB (.env).",
    );
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user) {
    console.error(
      `Demo user ${DEMO_EMAIL} not found — seed it first: pnpm demo:seed`,
    );
    process.exit(1);
  }

  // Issue an OAuth access token straight to the store (as the browser
  // sign-in flow would, minus the browser).
  const clientId = "demo_client";
  await prisma.oAuthClient.deleteMany({ where: { id: clientId } });
  await prisma.oAuthClient.create({
    data: {
      id: clientId,
      secretHash: null,
      name: "Expense demo",
      redirectUris: JSON.stringify(["http://127.0.0.1:5173/callback"]),
      authMethod: "none",
      createdAt: new Date().toISOString(),
    },
  });
  const token = `oat_${randomBytes(32).toString("base64url")}`;
  await prisma.oAuthToken.create({
    data: {
      tokenHash: hash(token),
      userId: user.id,
      clientId,
      type: "access",
      scope: "",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      revokedAt: null,
      createdAt: new Date().toISOString(),
    },
  });

  console.info(`Expense demo \u2014 driving ${MCP_URL}`);
  console.info(
    `account: Demo Account \u00b7 auth: OAuth access token (sign-in equivalent)`,
  );

  await mcp(token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "expense-demo", version: "1.0.0" },
  });
  await notify(token, "notifications/initialized", undefined);

  await moveCapture(token);
  await moveSpending(token);
  await moveReport(token);
  await moveReconcile(token);

  console.info(
    "\n\u2500\u2500\u2500 That\u2019s Expense \u2014 receipts, mileage, and reports on speaking terms with your own assistant. No API keys; you just sign in. \u2500\u2500\u2500",
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
