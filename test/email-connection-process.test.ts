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
  type OwnerEmail,
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
    reviewScannedAt: null,
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
  // emailAddress is globally unique: clear by address, not id.
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
    expect(result.status).toBe("partial");
    expect(trashed).toEqual(["e1"]);
    // The expense exists with the extracted data. Local extraction names
    // the merchant from the rule sender domain and parses the total; the
    // category is "" until the user sets it once (completeness badge).
    const expenses = await readExpenses(conn.accountId);
    const created = expenses.find(
      (e) => e.id === (result as { expenseId: string }).expenseId,
    );
    expect(created?.type === "receipt" && created.merchant).toBe("Apple");
    expect(created?.amount?.toString()).toBe("1.23");
    expect(created?.category).toBe("");
    // The owner got one notification FROM their own mailbox TO themselves.
    expect(mocks.sendConnectionEmail).toHaveBeenCalledTimes(1);
    const sent = mocks.sendConnectionEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
    };
    expect(sent.subject).toContain("Receipt accepted");
    // Logged as partial (category unknown under local extraction).
    expect((await logRow(conn.id, "e1"))?.outcome).toBe("partial");
  });

  it("suppresses the second confirmation when the same receipt was already imported recently", async () => {
    // Cross-pipeline overlap: the same receipt exists in the Inbox AND as
    // the user's forward to the receipts address. Both are imported (two
    // different emails), but the owner must get one confirmation, not two.
    await addEmailRule({
      accountId: "",
      sender: "dedupco.com",
      source: "seed",
    });
    const { adapter } = fakeAdapter(
      new Map([
        [
          "e1",
          {
            from: "DedupCo <no_reply@dedupco.com>",
            subject: "Your receipt",
            body: "MERCHANT: DedupCo\nTOTAL: 4.56\nCATEGORY: office supplies",
          },
        ],
        [
          "e2",
          {
            from: "DedupCo <no_reply@dedupco.com>",
            subject: "Your receipt",
            body: "MERCHANT: DedupCo\nTOTAL: 4.56\nCATEGORY: office supplies",
          },
        ],
      ]),
    );
    const adapters = {
      moveToTrash: (id: string) => adapter.moveToTrash(id),
      sendToOwner: async (email: OwnerEmail) => {
        await mocks.sendConnectionEmail(email);
      },
    };

    const first = await processConnectionEmail(
      conn,
      summary("e1", "DedupCo <no_reply@dedupco.com>", "Your receipt"),
      depsFor(adapter, conn.id),
      adapters,
    );
    expect(first.status).toBe("partial");
    expect(mocks.sendConnectionEmail).toHaveBeenCalledTimes(1);

    const second = await processConnectionEmail(
      conn,
      summary("e2", "DedupCo <no_reply@dedupco.com>", "Your receipt"),
      depsFor(adapter, conn.id),
      adapters,
    );
    expect(second.status).toBe("partial");
    // The second import saved its own expense row but the confirmation is
    // suppressed; still exactly one notification to the owner.
    expect(mocks.sendConnectionEmail).toHaveBeenCalledTimes(1);
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
    const extractReceipt = vi.fn((input) => deps.extractReceipt(input));
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

  it("ignores the app's own confirmation email (loop guard via header)", async () => {
    // The app's outbound confirmation carries X-Expense-Confirmation.
    // If one lands back in the Inbox it must never reprocess, even if a
    // rule matched its sender (the header is the stable signal).
    await addEmailRule({
      accountId: "",
      sender: "labnotes.org",
      source: "seed",
    });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "e8",
          {
            from: "Expense <assaf@labnotes.org>",
            subject: "👍 Receipt accepted: $10.00 — Software — 2026 Business",
            body: "Receipt accepted. Total: $10.00",
          },
        ],
      ]),
    );
    // The fake adapter builds a text/plain body with no headers; inject the
    // X-header via a custom fetch that returns headers on the ReceivedEmail.
    const deps = depsFor(adapter, conn.id);
    const guarded = {
      ...deps,
      fetchReceivedEmail: async (emailId: string) => {
        const base = await deps.fetchReceivedEmail(emailId);
        return {
          ...base,
          headers: { ...base.headers, "X-Expense-Confirmation": "1" },
        };
      },
    };
    const extractReceipt = vi.fn((input) => deps.extractReceipt(input));
    guarded.extractReceipt = extractReceipt;
    const result = await processConnectionEmail(
      conn,
      summary("e8", "assaf@labnotes.org", "👍 Receipt accepted"),
      guarded,
      {
        moveToTrash: (id: string) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("ignored");
    expect((result as { reason: string }).reason).toBe("own confirmation");
    expect(trashed).toEqual([]);
    expect(extractReceipt).not.toHaveBeenCalled();
    expect((await logRow(conn.id, "e8"))?.outcome).toBe("ignored");
  });

  it("extracts a first-time receipt locally without ever calling the model", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "e6",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Your receipt from Apple",
            body: "App Store\nTotal: $19.99\nBill #77-001\nAccount billed ZHED Media LLC x@y.com",
          },
        ],
      ]),
    );
    const deps = depsFor(adapter, conn.id);
    const extractReceipt = vi.fn((input) => deps.extractReceipt(input));
    const guarded: typeof deps = { ...deps, extractReceipt };
    const result = await processConnectionEmail(
      conn,
      summary(
        "e6",
        "Apple <no_reply@email.apple.com>",
        "Your receipt from Apple",
      ),
      guarded,
      {
        moveToTrash: (id: string) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    // Created (partial: category unknown) with NO model call.
    expect(result.status).toBe("partial");
    expect(trashed).toEqual(["e6"]);
    expect(extractReceipt).not.toHaveBeenCalled();
    const expenses = await readExpenses(conn.accountId);
    const e = expenses.find(
      (x) => x.id === (result as { expenseId: string }).expenseId,
    );
    expect(e?.type === "receipt" && e.merchant).toBe("Apple");
    expect(e?.type === "receipt" && e.amount?.toString()).toBe("19.99");
    expect(e?.type === "receipt" && e.description).toBe(
      "#77-001 — ZHED Media LLC",
    );
  });

  it("skips a receipt whose total can't be parsed locally, leaves it in Inbox", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "e7",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Your receipt from Apple",
            // No "total" keyword, no currency marker -> parseReceiptAmount returns null.
            body: "Order processed. Reference 4815162342.",
          },
        ],
      ]),
    );
    const deps = depsFor(adapter, conn.id);
    const extractReceipt = vi.fn((input) => deps.extractReceipt(input));
    const guarded: typeof deps = { ...deps, extractReceipt };
    const before = (await readExpenses(conn.accountId)).length;
    const result = await processConnectionEmail(
      conn,
      summary(
        "e7",
        "Apple <no_reply@email.apple.com>",
        "Your receipt from Apple",
      ),
      guarded,
      {
        moveToTrash: (id: string) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("ignored");
    expect((result as { reason: string }).reason).toBe(
      "not extractable locally",
    );
    // Never trashed, never expensed, model never called.
    expect(trashed).toEqual([]);
    expect(extractReceipt).not.toHaveBeenCalled();
    const after = (await readExpenses(conn.accountId)).length;
    expect(after).toBe(before);
    expect((await logRow(conn.id, "e7"))?.outcome).toBe("ignored");
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

  it("does not double-process a concurrently-drained email (claim guard)", async () => {
    // Two drains race on the same email (push + push, or push + cron).
    // The atomic claim must let only one create an expense; the other
    // returns "already processed". Previously both read "fresh" and both
    // created an expense (the #1639-4741 dupe).
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "e9",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Your receipt from Apple",
            body: "MERCHANT: Apple\nTOTAL: 7.77",
          },
        ],
      ]),
    );
    const deps = depsFor(adapter, conn.id);
    const opts = {
      moveToTrash: (id: string) => adapter.moveToTrash(id),
      sendToOwner: async () => {},
    };
    // Fire both concurrently; the claim is the only thing preventing a dupe.
    const [a, b] = await Promise.all([
      processConnectionEmail(
        conn,
        summary(
          "e9",
          "Apple <no_reply@email.apple.com>",
          "Your receipt from Apple",
        ),
        deps,
        opts,
      ),
      processConnectionEmail(
        conn,
        summary(
          "e9",
          "Apple <no_reply@email.apple.com>",
          "Your receipt from Apple",
        ),
        deps,
        opts,
      ),
    ]);
    const statuses = [a.status, b.status].sort();
    // One winner (partial, since local extraction leaves category empty) and one
    // loser ("already processed"). Never two expenses.
    expect(statuses).toContain("ignored");
    expect(statuses.filter((s) => s === "ignored")).toHaveLength(1);
    expect(
      statuses.filter((s) => s === "created" || s === "partial"),
    ).toHaveLength(1);
    const winner = [a, b].find(
      (r) => r.status === "created" || r.status === "partial",
    ) as { status: string; expenseId?: string } | undefined;
    expect(winner).toBeDefined();
    expect(winner?.expenseId).toBeDefined();
    // Exactly one expense, the winner's; the loser created none.
    const expenses = await readExpenses(conn.accountId);
    const created = expenses.filter((e) => e.id === winner?.expenseId);
    expect(created).toHaveLength(1);
    expect(created[0]?.amount?.toString()).toBe("7.77");
    expect(trashed).toHaveLength(1);
    const row = await logRow(conn.id, "e9");
    expect(row?.outcome).toBe("partial");
    const connectionRow = await testPrisma.emailConnection.findUnique({
      where: { id: conn.id },
    });
    expect(connectionRow?.receivedCount).toBe(1);
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
      created: 0,
      partial: 1,
      ignored: 1,
      failed: 0,
    });

    const row = await testPrisma.emailConnection.findUnique({
      where: { id: conn.id },
    });
    expect(row?.receivedCount).toBe(2);
    expect(row?.processedCount).toBe(1);

    // Second drain: everything already evaluated, no new counters, no new expenses.
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
    // Drain now sees the email as already evaluated (error outcome):
    // the catch-up cron does not retry errors (they stay visible in the Inbox).
    const drain = await drainEmailConnection(conn, { adapter, batchSize: 10 });
    expect(drain.evaluated).toBe(0);
  });

  it("reaches fresh mail behind an all-seen front (cursor scan)", async () => {
    // The catch-up drain used to stop at the first batch with no fresh
    // mail, so ignored mail that stays in the Inbox (newsletters, self
    // mail) built a wall in front of newer receipts, and the cron never
    // reached them (the Shopify bill sat behind one). The cursor scan
    // slides past all-seen batches instead of stopping.
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    // A faithful paging adapter: respects afterIso + limit, per-email
    // receivedAt, and hides trashed mail (like a real Inbox query).
    const emails: Array<{
      id: string;
      from: string;
      subject: string;
      body: string;
      receivedAt: string;
    }> = [
      {
        id: "g1",
        from: "newsletter@random.com",
        subject: "Digest",
        body: "nothing to see",
        receivedAt: "2026-07-13T10:00:00.000Z",
      },
    ];
    const trashed: string[] = [];
    const adapter: ConnectionMailAdapter = {
      inboxEmailSummaries: async (opts) =>
        emails
          .filter(
            (e) =>
              !trashed.includes(e.id) && e.receivedAt > (opts.afterIso ?? ""),
          )
          .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
          .slice(0, opts.limit)
          .map((e) => ({
            id: e.id,
            receivedAt: e.receivedAt,
            subject: e.subject,
            from: e.from,
          })),
      rawEmail: async (id) => {
        const e = emails.find((x) => x.id === id);
        if (!e) throw new Error(`email ${id} not found`);
        return {
          id,
          raw: Buffer.from(
            [
              `From: ${e.from}`,
              "To: mailbox@example.com",
              `Subject: ${e.subject}`,
              `Date: ${new Date(e.receivedAt).toUTCString()}`,
              `Message-ID: <${id}@example.com>`,
              "Content-Type: text/plain; charset=utf-8",
              "",
              e.body,
            ].join("\r\n"),
          ),
          receivedAt: e.receivedAt,
          subject: e.subject,
          from: e.from,
          to: ["mailbox@example.com"],
          messageId: `<${id}@example.com>`,
        };
      },
      moveToTrash: async (id) => {
        trashed.push(id);
      },
    };

    // First drain: g1 is evaluated once (no rule → ignored, stays, seen).
    const first = await drainEmailConnection(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      batchSize: 1,
    });
    expect(first).toEqual({
      evaluated: 1,
      created: 0,
      partial: 0,
      ignored: 1,
      failed: 0,
    });

    // A receipt arrives, NEWER than the seen wall in front of it.
    emails.push({
      id: "g2",
      from: "Apple <no_reply@email.apple.com>",
      subject: "Your receipt from Apple",
      body: "MERCHANT: Apple\nTOTAL: 6.66",
      receivedAt: "2026-07-14T11:00:00.000Z",
    });

    // batchSize 1: the first batch is the seen g1; the cursor must scan
    // past it and reach g2 (the old code stopped dead at g1).
    const second = await drainEmailConnection(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      batchSize: 1,
    });
    expect(second.evaluated).toBe(1);
    expect(second.created + second.partial).toBe(1);
    expect(trashed).toContain("g2");
    const row = await logRow(conn.id, "g2");
    expect(row?.outcome === "created" || row?.outcome === "partial").toBe(true);
    const expenses = await readExpenses(conn.accountId);
    const created = expenses.find(
      (e) => e.type === "receipt" && e.amount?.toString() === "6.66",
    );
    expect(created).toBeDefined();
    expect(created?.type === "receipt" && created.merchant).toBe("Apple");
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
