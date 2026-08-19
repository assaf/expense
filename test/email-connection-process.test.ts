import { beforeEach, describe, expect, it, vi } from "vitest";
import PostalMime from "postal-mime";
import { normalizeAmount } from "~/lib/format";
import type { ExtractionResult } from "~/lib/receipt-ai.server";
import {
  drainEmailConnection,
  processConnectionEmail,
  connectionInboundDeps,
  type ConnectionDeps,
  type ConnectionMailAdapter,
} from "~/lib/email-connection-process.server";
import type { ConnectionEmailSummary } from "~/lib/email-connection-mail.server";
import { encryptSecret } from "~/lib/token-crypto.server";
import { addEmailRule } from "~/lib/db/email-rules";
import { readExpenses } from "~/lib/db/expenses";
import { testPrisma, TEST_ACCOUNT_ID } from "./helpers/seedTestData";

/**
 * The connected-account processing pipeline: fake mailbox adapter + fake
 * extraction collaborators over the real test database (rules, process log,
 * counters, expenses).
 */

vi.mock("~/lib/email-connection-mail.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/lib/email-connection-mail.server")
  >()),
  sendConnectionEmail: mocks.sendConnectionEmail,
}));

const mocks = vi.hoisted(() => ({
  sendConnectionEmail: vi.fn(async (..._args: unknown[]) => true),
}));

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function connection() {
  return {
    id: `conn-${Math.random().toString(36).slice(2)}`,
    accountId: TEST_ACCOUNT_ID,
    provider: "fastmail",
    emailAddress: "mailbox@example.com",
    status: "active",
    receivedCount: 0,
    processedCount: 0,
    lastPushAt: null,
    pushSubscriptionId: null,
    pushExpiresAt: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    tokenEnc: encryptSecret("fmu1-conn-tok"),
    jmapAccountId: "jmap-1",
  };
}

function summary(
  id: string,
  from: string,
  subject: string,
): ConnectionEmailSummary {
  return { id, receivedAt: "2026-07-01T10:00:00.000Z", subject, from };
}

/** Deterministic fake "model": reads MERCHANT:/TOTAL:/CATEGORY: markers. */
function fakeExtract(text?: string): ExtractionResult {
  const t = text ?? "";
  return {
    isReceipt: t.includes("TOTAL:") || t.includes("MERCHANT:"),
    merchant: t.match(/MERCHANT:\s*([^\n]+)/i)?.[1]?.trim() ?? "",
    description: "",
    amount: normalizeAmount(
      t.match(/TOTAL:\s*\$?([0-9]+(?:\.[0-9]{1,2})?)/i)?.[1] ?? "",
    ),
    currency: "USD",
    category: t.match(/CATEGORY:\s*([^\n]+)/i)?.[1]?.trim() ?? "",
    report: "",
    confidence: "high",
    notes: "",
  };
}

function fakeExtractionDeps(): ConnectionDeps {
  return {
    classifyAttachment: async () => null,
    extractReceipt: async (input) => fakeExtract(input.text),
    extractFromImage: async () => ({
      result: fakeExtract("MERCHANT: Photo Shop\nTOTAL: 5.00"),
      text: "",
      stored: { buffer: TINY_PNG, mime: "image/png" },
    }),
    renderReceiptImage: async () => TINY_PNG,
    renderEmailImage: async () => TINY_PNG,
    renderTextEmail: async () => TINY_PNG,
  };
}

/** A fake mailbox adapter over an in-memory set of raw RFC 822 emails. */
function fakeAdapter(
  emails: Map<string, { from: string; subject: string; body: string }>,
) {
  const trashed: string[] = [];
  const adapter: ConnectionMailAdapter = {
    inboxEmailSummaries: async () =>
      [...emails.entries()].map(([id, e]) => summary(id, e.from, e.subject)),
    rawEmail: async (id) => {
      const e = emails.get(id);
      if (!e) throw new Error(`email ${id} not found`);
      const raw = Buffer.from(
        [
          `From: ${e.from}`,
          "To: mailbox@example.com",
          `Subject: ${e.subject}`,
          "Date: Tue, 01 Jul 2026 10:00:00 +0000",
          "Message-ID: <msg@example.com>",
          "Content-Type: text/plain; charset=utf-8",
          "",
          e.body,
        ].join("\r\n"),
      );
      return {
        id,
        raw,
        receivedAt: "2026-07-01T10:00:00.000Z",
        subject: e.subject,
        from: e.from,
        to: ["mailbox@example.com"],
        messageId: "<msg@example.com>",
      };
    },
    moveToTrash: async (id) => {
      trashed.push(id);
    },
  };
  return { adapter, trashed };
}

function depsFor(adapter: ConnectionMailAdapter, connectionId: string) {
  return connectionInboundDeps(connectionId, adapter, fakeExtractionDeps());
}

async function cleanupConnection() {
  // emailAddress is globally unique — clear by address, not id.
  const rows = await testPrisma.emailConnection.findMany({
    where: { emailAddress: "mailbox@example.com" },
    select: { id: true },
  });
  await testPrisma.emailProcessLog.deleteMany({
    where: { connectionId: { in: rows.map((r) => r.id) } },
  });
  await testPrisma.emailConnection.deleteMany({
    where: { emailAddress: "mailbox@example.com" },
  });
}

async function logRow(connectionId: string, emailId: string) {
  return testPrisma.emailProcessLog.findUnique({
    where: { connectionId_emailId: { connectionId, emailId } },
  });
}

describe("processConnectionEmail", () => {
  let conn: ReturnType<typeof connection>;

  beforeEach(async () => {
    conn = connection();
    await cleanupConnection();
    await testPrisma.emailConnection.create({
      data: {
        id: conn.id,
        accountId: conn.accountId,
        provider: conn.provider,
        emailAddress: conn.emailAddress,
        jmapAccountId: conn.jmapAccountId,
        tokenEnc: conn.tokenEnc,
        createdAt: conn.createdAt,
      },
    });
    await testPrisma.emailRule.deleteMany({
      where: { accountId: conn.accountId, source: "forward" },
    });
    mocks.sendConnectionEmail.mockClear();
  });

  it("creates an expense for a rule-matched receipt, trashes, notifies the owner", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "e1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Your receipt",
            body: "MERCHANT: Apple\nTOTAL: 1.23\nCATEGORY: office supplies",
          },
        ],
      ]),
    );
    const result = await processConnectionEmail(
      conn,
      summary("e1", "Apple <no_reply@email.apple.com>", "Your receipt"),
      depsFor(adapter, conn.id),
      {
        moveToTrash: (id) => adapter.moveToTrash(id),
        sendToOwner: async (email) => {
          await mocks.sendConnectionEmail(email);
        },
      },
    );
    expect(result.status).toBe("created");
    expect(trashed).toEqual(["e1"]);
    // The expense exists with the extracted data.
    const expenses = await readExpenses(conn.accountId);
    const created = expenses.find(
      (e) => e.id === (result as { expenseId: string }).expenseId,
    );
    expect(created?.type === "receipt" && created.merchant).toBe("Apple");
    expect(created?.amount?.toString()).toBe("1.23");
    // The owner got one notification FROM their own mailbox TO themselves.
    expect(mocks.sendConnectionEmail).toHaveBeenCalledTimes(1);
    const sent = mocks.sendConnectionEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
    };
    expect(sent.subject).toContain("Receipt accepted");
    // Logged.
    expect((await logRow(conn.id, "e1"))?.outcome).toBe("created");
  });

  it("ignores emails with no matching rule and leaves them in the Inbox", async () => {
    const { adapter, trashed } = fakeAdapter(new Map());
    const result = await processConnectionEmail(
      conn,
      summary("e2", "newsletter@random.com", "Weekly digest"),
      depsFor(adapter, conn.id),
      {
        moveToTrash: (id: string) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("ignored");
    expect(trashed).toEqual([]);
    expect(mocks.sendConnectionEmail).not.toHaveBeenCalled();
    expect((await logRow(conn.id, "e2"))?.outcome).toBe("ignored");
    expect(
      (await readExpenses(conn.accountId)).find(
        (e) => e.type === "receipt" && e.merchant === "Digest",
      ),
    ).toBeUndefined();
  });

  it("ignores the owner's own email (self guard)", async () => {
    await addEmailRule({
      accountId: "",
      sender: "example.com",
      source: "seed",
    });
    const { adapter, trashed } = fakeAdapter(new Map());
    const result = await processConnectionEmail(
      conn,
      summary("e3", "Mailbox <mailbox@example.com>", "Note to self"),
      depsFor(adapter, conn.id),
      {
        moveToTrash: (id: string) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("ignored");
    expect((result as { reason: string }).reason).toBe("self");
    expect(trashed).toEqual([]);
  });

  it("ignores marketing mail from a rule-matched sender without calling the model", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "e4",
          {
            from: "Apple <news@email.apple.com>",
            subject: "New products!",
            body: "Check out our new line of products. No totals here.",
          },
        ],
      ]),
    );
    const deps = depsFor(adapter, conn.id);
    const extractReceipt = vi.fn(deps.extractReceipt);
    const guarded: typeof deps = { ...deps, extractReceipt };
    const result = await processConnectionEmail(
      conn,
      summary("e4", "Apple <news@email.apple.com>", "New products!"),
      guarded,
      {
        moveToTrash: (id: string) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("ignored");
    expect((result as { reason: string }).reason).toBe("not a receipt (local)");
    expect(trashed).toEqual([]);
    expect(extractReceipt).not.toHaveBeenCalled();
    expect((await logRow(conn.id, "e4"))?.matched).toBe(true);
  });

  it("logs errors and leaves the email untouched", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "e5",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Your receipt",
            body: "MERCHANT: Apple\nTOTAL: 9.99",
          },
        ],
      ]),
    );
    const deps = {
      ...depsFor(adapter, conn.id),
      fetchReceivedEmail: async () => {
        throw new Error("mailbox exploded");
      },
    };
    const result = await processConnectionEmail(
      conn,
      summary("e5", "Apple <no_reply@email.apple.com>", "Your receipt"),
      deps,
      {
        moveToTrash: (id: string) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("error");
    expect(trashed).toEqual([]);
    const row = await logRow(conn.id, "e5");
    expect(row?.outcome).toBe("error");
    expect(row?.error).toContain("mailbox exploded");
  });
});

describe("drainEmailConnection", () => {
  let conn: ReturnType<typeof connection>;

  beforeEach(async () => {
    conn = connection();
    await cleanupConnection();
    await testPrisma.emailConnection.create({
      data: {
        id: conn.id,
        accountId: conn.accountId,
        provider: conn.provider,
        emailAddress: conn.emailAddress,
        jmapAccountId: conn.jmapAccountId,
        tokenEnc: conn.tokenEnc,
        createdAt: conn.createdAt,
      },
    });
    await testPrisma.emailRule.deleteMany({
      where: { accountId: conn.accountId, source: "forward" },
    });
    mocks.sendConnectionEmail.mockClear();
  });

  it("evaluates new mail, bumps counters, and is idempotent", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter } = fakeAdapter(
      new Map([
        [
          "d1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt 1",
            body: "MERCHANT: Apple\nTOTAL: 3.50\nCATEGORY: office supplies",
          },
        ],
        [
          "d2",
          {
            from: "newsletter@random.com",
            subject: "Digest",
            body: "nothing to see",
          },
        ],
      ]),
    );

    const first = await drainEmailConnection(conn, { adapter, batchSize: 10 });
    expect(first).toEqual({
      evaluated: 2,
      created: 1,
      partial: 0,
      ignored: 1,
      failed: 0,
    });

    const row = await testPrisma.emailConnection.findUnique({
      where: { id: conn.id },
    });
    expect(row?.receivedCount).toBe(2);
    expect(row?.processedCount).toBe(1);

    // Second drain: everything already evaluated — no new counters, no new expenses.
    const second = await drainEmailConnection(conn, { adapter, batchSize: 10 });
    expect(second.evaluated).toBe(0);
    const after = await testPrisma.emailConnection.findUnique({
      where: { id: conn.id },
    });
    expect(after?.receivedCount).toBe(2);
    expect(after?.processedCount).toBe(1);
  });

  it("keeps a failed email in the Inbox but never re-creates the expense", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const emails = new Map([
      [
        "f1",
        {
          from: "Apple <no_reply@email.apple.com>",
          subject: "Receipt",
          body: "MERCHANT: Apple\nTOTAL: 7.77\nCATEGORY: office supplies",
        },
      ],
    ]);
    const { adapter } = fakeAdapter(emails);
    // First drain fails at the mailbox level.
    // Process one email directly with a throwing fetch to log an error row.
    const deps = {
      ...connectionInboundDeps(conn.id, adapter, fakeExtractionDeps()),
      fetchReceivedEmail: async () => {
        throw new Error("transient");
      },
    };
    const result = await processConnectionEmail(
      conn,
      summary("f1", "Apple <no_reply@email.apple.com>", "Receipt"),
      deps,
      {
        moveToTrash: (id: string) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("error");
    // Drain now sees the email as already evaluated (error outcome) —
    // the catch-up cron does not retry errors (they stay visible in the Inbox).
    const drain = await drainEmailConnection(conn, { adapter, batchSize: 10 });
    expect(drain.evaluated).toBe(0);
  });
});

// PostalMime sanity: the fake adapter's raw emails parse as expected.
describe("fake adapter raw email", () => {
  it("parses via postal-mime", async () => {
    const { adapter } = fakeAdapter(
      new Map([
        [
          "p1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Your receipt",
            body: "MERCHANT: Apple\nTOTAL: 1.23\nCATEGORY: office supplies",
          },
        ],
      ]),
    );
    const raw = await adapter.rawEmail("p1");
    const parsed = await PostalMime.parse(raw.raw);
    expect(parsed.subject).toBe("Your receipt");
    expect(parsed.text).toContain("TOTAL: 1.23");
  });
});
