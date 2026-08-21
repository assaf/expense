import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionResult } from "~/lib/receipt-ai.server";
import {
  scanConnectionInbox,
  listReviewItems,
  ignoreReviewItem,
  processReviewItem,
  reviewSenderRulePattern,
} from "~/lib/email-review.server";
import type { ConnectionDeps } from "~/lib/email-connection-process.server";
import type { ConnectionEmailSummary } from "~/lib/email-connection-mail.server";
import { encryptSecret } from "~/lib/token-crypto.server";
import { addEmailRule, matchEmailRule } from "~/lib/db/email-rules";
import { readExpenses } from "~/lib/db/expenses";
import { testPrisma, TEST_ACCOUNT_ID } from "./helpers/seedTestData";

/**
 * The inbox review flow: scan a connected inbox for receipt-like emails,
 * list them (receivedAt/sender/subject), and process/ignore each. Fake
 * mailbox adapter + fake extraction collaborators over the real test
 * database (rules, process log, counters, expenses).
 */

const mocks = vi.hoisted(() => ({
  deliverConnectionEmailToInbox: vi.fn(async () => true),
}));

// The review flow's owner confirmation goes through the JMAP mailbox; in
// tests that must not hit FastMail, so the delivery is faked.
vi.mock("~/lib/email-connection-mail.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/lib/email-connection-mail.server")
  >()),
  deliverConnectionEmailToInbox: mocks.deliverConnectionEmailToInbox,
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
  receivedAt = "2026-07-01T10:00:00.000Z",
): ConnectionEmailSummary {
  return { id, receivedAt, subject, from };
}

/** Deterministic fake "model": reads MERCHANT:/TOTAL:/CATEGORY: markers. */
function fakeExtract(text?: string): ExtractionResult {
  const t = text ?? "";
  return {
    isReceipt: t.includes("TOTAL:") || t.includes("MERCHANT:"),
    merchant: t.match(/MERCHANT:\s*([^\n]+)/i)?.[1]?.trim() ?? "",
    description: "",
    amount: t.match(/TOTAL:\s*\$?([0-9]+(?:\.[0-9]{1,2})?)/i)?.[1] ?? "",
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

/** A fake mailbox adapter over an in-memory set of raw RFC 822 emails.
 * Honours the `limit`/`descending` query shape so the scan's bounded-batch
 * behaviour is testable, and records every query call. */
function fakeAdapter(
  emails: Map<string, { from: string; subject: string; body: string }>,
) {
  const trashed: string[] = [];
  const queries: Array<{
    afterIso?: string;
    limit: number;
    descending?: boolean;
  }> = [];
  const adapter = {
    inboxEmailSummaries: async (opts: {
      afterIso?: string;
      limit: number;
      descending?: boolean;
    }) => {
      queries.push(opts);
      let list = [...emails.entries()].map(([id, e]) =>
        summary(id, e.from, e.subject),
      );
      list = list.slice(0, opts.limit);
      return list;
    },
    rawEmail: async (id: string) => {
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
    moveToTrash: async (id: string) => {
      trashed.push(id);
    },
  };
  return { adapter, trashed, queries };
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
  await testPrisma.emailRule.deleteMany({
    where: { accountId: TEST_ACCOUNT_ID, source: "review" },
  });
}

async function logRow(connectionId: string, emailId: string) {
  return testPrisma.emailProcessLog.findUnique({
    where: { connectionId_emailId: { connectionId, emailId } },
  });
}

async function createPendingItem(
  connectionId: string,
  emailId: string,
  from = "Apple <no_reply@email.apple.com>",
  subject = "Your receipt",
  receivedAt = "2026-07-01T10:00:00.000Z",
) {
  await testPrisma.emailProcessLog.create({
    data: {
      connectionId,
      emailId,
      fromAddress: from.includes("<")
        ? from.match(/<([^>]+)>/)![1]!.toLowerCase()
        : from.toLowerCase(),
      fromDisplay: from,
      subject,
      matched: false,
      outcome: "pending-review",
      receivedAt,
      createdAt: new Date().toISOString(),
    },
  });
}

describe("reviewSenderRulePattern", () => {
  it("uses the domain for real senders (matches subdomains)", () => {
    expect(reviewSenderRulePattern("no_reply@email.apple.com")).toBe(
      "email.apple.com",
    );
  });

  it("uses the exact address for freemail providers", () => {
    expect(reviewSenderRulePattern("bob@gmail.com")).toBe("bob@gmail.com");
  });
});

describe("scanConnectionInbox", () => {
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
    mocks.deliverConnectionEmailToInbox.mockClear();
  });

  it("adds receipt-like emails to the review list with display data", async () => {
    const { adapter, queries } = fakeAdapter(
      new Map([
        [
          "e1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Your receipt",
            body: "MERCHANT: Apple\nTOTAL: 9.99",
          },
        ],
        [
          "e2",
          {
            from: "Store <news@store.com>",
            subject: "Big sale this week",
            body: "Unsubscribe now to stop receiving these.",
          },
        ],
        [
          "e3",
          {
            from: "Uber <no-reply@uber.com>",
            subject: "Thanks for riding",
            body: "Amount due: $42.00. Ride completed.",
          },
        ],
      ]),
    );

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
    });

    expect(result.added).toBe(2);
    expect(result.pending).toBe(2);
    expect(result.finished).toBe(true);
    expect(result.atCap).toBe(false); // small mailbox — everything was scanned
    // One bounded query: the 50 most recent emails, newest first.
    expect(queries).toEqual([{ limit: 50, descending: true }]);

    const items = await listReviewItems(conn.id);
    const byId = new Map(items.map((i) => [i.emailId, i]));

    // The receipt (subject signal) and the bland-subject-with-total are in.
    const e1 = byId.get("e1");
    expect(e1?.subject).toBe("Your receipt");
    expect(e1?.fromDisplay).toBe("Apple <no_reply@email.apple.com>");
    expect(e1?.fromAddress).toBe("no_reply@email.apple.com");
    expect(e1?.receivedAt).toBe("2026-07-01T10:00:00.000Z");

    const e3 = byId.get("e3");
    expect(e3?.fromAddress).toBe("no-reply@uber.com");

    // Marketing mail without money is not on the list.
    expect(byId.has("e2")).toBe(false);
    // The row for a non-receipt was never written (the next scan re-checks).
    expect(await logRow(conn.id, "e2")).toBeNull();

    // Both candidates are on the list (newest-first; same receivedAt here,
    // so tie order is unspecified — compare as a set).
    expect(items.map((i) => i.emailId).sort()).toEqual(["e1", "e3"]);

    // The scan stamped reviewScannedAt.
    const row = await testPrisma.emailConnection.findUnique({
      where: { id: conn.id },
    });
    expect(row?.reviewScannedAt).not.toBeNull();
  });

  it("skips emails already processed, ignored by the user, or being processed", async () => {
    await createPendingItem(conn.id, "e1");
    await testPrisma.emailProcessLog.createMany({
      data: [
        {
          connectionId: conn.id,
          emailId: "e2",
          fromAddress: "b@example.com",
          subject: "done",
          matched: true,
          outcome: "created",
          createdAt: new Date().toISOString(),
        },
        {
          connectionId: conn.id,
          emailId: "e3",
          fromAddress: "c@example.com",
          subject: "ignored",
          matched: false,
          outcome: "review-ignored",
          error: "user ignored",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const { adapter } = fakeAdapter(
      new Map([
        [
          "e1",
          {
            from: "A <a@example.com>",
            subject: "Your receipt",
            body: "TOTAL: 1.00",
          },
        ],
        [
          "e2",
          {
            from: "B <b@example.com>",
            subject: "Your receipt",
            body: "TOTAL: 2.00",
          },
        ],
        [
          "e3",
          {
            from: "C <c@example.com>",
            subject: "Your receipt",
            body: "TOTAL: 3.00",
          },
        ],
        [
          "e4",
          {
            from: "D <d@example.com>",
            subject: "Your receipt",
            body: "TOTAL: 4.00",
          },
        ],
      ]),
    );

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
    });

    // Only e4 was new; e1 was already on the list (counted as pending).
    expect(result.added).toBe(1);
    expect(result.pending).toBe(2);
    const items = await listReviewItems(conn.id);
    expect(items.map((i) => i.emailId).sort()).toEqual(["e1", "e4"]);
  });

  it("never re-offers bounces, self mail, or the app's own confirmations", async () => {
    await testPrisma.emailProcessLog.createMany({
      data: [
        {
          connectionId: conn.id,
          emailId: "e1",
          fromAddress: "postmaster@example.com",
          subject: "Undelivered Mail",
          matched: false,
          outcome: "ignored",
          error: "bounce",
          createdAt: new Date().toISOString(),
        },
        {
          connectionId: conn.id,
          emailId: "e2",
          fromAddress: conn.emailAddress,
          subject: "Your receipt",
          matched: false,
          outcome: "ignored",
          error: "self",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    // Even though every email here looks like a receipt, the ignored reasons
    // are decisive — the scan must not re-offer them.
    const { adapter } = fakeAdapter(
      new Map([
        [
          "e1",
          {
            from: "postmaster@example.com",
            subject: "Undelivered Mail",
            body: "TOTAL: 1.00",
          },
        ],
        [
          "e2",
          {
            from: conn.emailAddress,
            subject: "Your receipt",
            body: "TOTAL: 2.00",
          },
        ],
      ]),
    );

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
    });

    expect(result.added).toBe(0);
    expect(await listReviewItems(conn.id)).toEqual([]);
  });

  it("re-examines emails the pipeline couldn't process, and pipeline errors", async () => {
    await testPrisma.emailProcessLog.createMany({
      data: [
        {
          connectionId: conn.id,
          emailId: "e1",
          fromAddress: "x@example.com",
          subject: "Receipt",
          matched: true,
          outcome: "ignored",
          error: "not extractable locally",
          createdAt: new Date().toISOString(),
        },
        {
          connectionId: conn.id,
          emailId: "e2",
          fromAddress: "y@example.com",
          subject: "Receipt",
          matched: true,
          outcome: "error",
          error: "boom",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const { adapter } = fakeAdapter(
      new Map([
        [
          "e1",
          {
            from: "X <x@example.com>",
            subject: "Receipt",
            body: "TOTAL: 1.00",
          },
        ],
        [
          "e2",
          {
            from: "Y <y@example.com>",
            subject: "Receipt",
            body: "TOTAL: 2.00",
          },
        ],
      ]),
    );

    await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
    });

    const items = await listReviewItems(conn.id);
    expect(items.map((i) => i.emailId).sort()).toEqual(["e1", "e2"]);
    // The upsert flipped both rows to pending-review.
    expect((await logRow(conn.id, "e1"))?.outcome).toBe("pending-review");
    expect((await logRow(conn.id, "e2"))?.outcome).toBe("pending-review");
  });

  it("examines at most 50 emails per scan pass", async () => {
    // 60 receipt-like emails — the adapter honors the limit, so only the
    // most recent 50 are examined; the scan stays bounded and fast.
    const emails = new Map<
      string,
      { from: string; subject: string; body: string }
    >();
    for (let i = 0; i < 60; i++) {
      emails.set(`e${i}`, {
        from: `Sender ${i} <noreply@store${i}.example>`,
        subject: "Your receipt",
        body: `MERCHANT: Store ${i}\nTOTAL: ${i + 1}.00`,
      });
    }
    const { adapter, queries } = fakeAdapter(emails);

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
    });

    expect(queries).toEqual([{ limit: 50, descending: true }]);
    expect(result.scanned).toBe(50);
    expect(result.added).toBe(50);
    expect(result.pending).toBe(50);
    expect(result.atCap).toBe(true); // mailbox has more — older mail not offered
  });
});

describe("processReviewItem", () => {
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
    mocks.deliverConnectionEmailToInbox.mockClear();
  });

  it("creates an expense for a sender with no rule, trashes, and logs created", async () => {
    await createPendingItem(
      conn.id,
      "e1",
      "Acme <no_reply@acme.example>",
      "Your invoice",
    );
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "e1",
          {
            from: "Acme <no_reply@acme.example>",
            subject: "Your invoice",
            body: "MERCHANT: Acme Corp\nTOTAL: 12.34\nCATEGORY: office supplies",
          },
        ],
      ]),
    );

    const result = await processReviewItem({
      connection: conn,
      emailId: "e1",
      acceptSender: false,
      adapter,
      extractionDeps: fakeExtractionDeps(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expenses = await readExpenses(conn.accountId);
    const created = expenses.find((e) => e.id === result.expenseId);
    expect(created?.type === "receipt" && created.merchant).toBe("Acme Corp");
    expect(created?.amount?.toString()).toBe("12.34");
    // No rule matched — but the review flow processed it anyway (no rule gate).
    expect(
      await matchEmailRule(conn.accountId, "no_reply@acme.example"),
    ).toBeUndefined();
    // Email moved to Trash + the owner confirmation was delivered once.
    expect(trashed).toEqual(["e1"]);
    expect(mocks.deliverConnectionEmailToInbox).toHaveBeenCalledTimes(1);
    // Logged as created; item dropped off the list.
    expect((await logRow(conn.id, "e1"))?.outcome).toBe("created");
    expect(await listReviewItems(conn.id)).toEqual([]);
    // processedCount bumped.
    const row = await testPrisma.emailConnection.findUnique({
      where: { id: conn.id },
    });
    expect(row?.processedCount).toBe(1);
  });

  it("remember-sender adds a user rule (domain), skipped when one exists", async () => {
    await createPendingItem(
      conn.id,
      "e1",
      "Acme <no_reply@acme.example>",
      "Your invoice",
    );
    const { adapter } = fakeAdapter(
      new Map([
        [
          "e1",
          {
            from: "Acme <no_reply@acme.example>",
            subject: "Your invoice",
            body: "MERCHANT: Acme Corp\nTOTAL: 12.34",
          },
        ],
      ]),
    );
    const result = await processReviewItem({
      connection: conn,
      emailId: "e1",
      acceptSender: true,
      adapter,
      extractionDeps: fakeExtractionDeps(),
    });
    expect(result.ok).toBe(true);
    const learned = await testPrisma.emailRule.findFirst({
      where: { accountId: conn.accountId, sender: "acme.example" },
    });
    expect(learned?.source).toBe("review");

    // A second sender already covered by a GENERAL rule gets no user rule.
    await createPendingItem(
      conn.id,
      "e2",
      "Apple <no_reply@email.apple.com>",
      "Your receipt",
    );
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter: adapter2 } = fakeAdapter(
      new Map([
        [
          "e2",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Your receipt",
            body: "MERCHANT: Apple\nTOTAL: 1.00",
          },
        ],
      ]),
    );
    const result2 = await processReviewItem({
      connection: conn,
      emailId: "e2",
      acceptSender: true,
      adapter: adapter2,
      extractionDeps: fakeExtractionDeps(),
    });
    expect(result2.ok).toBe(true);
    expect(
      await testPrisma.emailRule.findFirst({
        where: { accountId: conn.accountId, sender: "apple.com" },
      }),
    ).toBeNull();
  });

  it("remembers freemail senders by exact address", async () => {
    await createPendingItem(
      conn.id,
      "e1",
      "Bob <bob@gmail.com>",
      "Your receipt",
    );
    const { adapter } = fakeAdapter(
      new Map([
        [
          "e1",
          {
            from: "Bob <bob@gmail.com>",
            subject: "Your receipt",
            body: "MERCHANT: Bob\nTOTAL: 5.00",
          },
        ],
      ]),
    );
    const result = await processReviewItem({
      connection: conn,
      emailId: "e1",
      acceptSender: true,
      adapter,
      extractionDeps: fakeExtractionDeps(),
    });
    expect(result.ok).toBe(true);
    const learned = await testPrisma.emailRule.findFirst({
      where: { accountId: conn.accountId, sender: "bob@gmail.com" },
    });
    expect(learned).not.toBeNull();
  });

  it("a failed process keeps the item on the list and reports the reason", async () => {
    // Body with no receipt markers → the fake model says not a receipt.
    await createPendingItem(
      conn.id,
      "e1",
      "Acme <no_reply@acme.example>",
      "Your invoice",
    );
    const { adapter } = fakeAdapter(
      new Map([
        [
          "e1",
          {
            from: "Acme <no_reply@acme.example>",
            subject: "Your invoice",
            body: "Just a hello, no money anywhere.",
          },
        ],
      ]),
    );
    const before = await readExpenses(conn.accountId);
    const result = await processReviewItem({
      connection: conn,
      emailId: "e1",
      acceptSender: false,
      adapter,
      extractionDeps: fakeExtractionDeps(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("receipt");
    // Item still on the list (outcome back to pending-review), no expense.
    const items = await listReviewItems(conn.id);
    expect(items.map((i) => i.emailId)).toEqual(["e1"]);
    expect((await logRow(conn.id, "e1"))?.outcome).toBe("pending-review");
    expect(await readExpenses(conn.accountId)).toHaveLength(before.length);
    // No confirmation, nothing trashed.
    expect(mocks.deliverConnectionEmailToInbox).not.toHaveBeenCalled();
  });

  it("refuses an email that is no longer on the list", async () => {
    await testPrisma.emailProcessLog.create({
      data: {
        connectionId: conn.id,
        emailId: "e1",
        fromAddress: "a@example.com",
        subject: "done",
        matched: true,
        outcome: "created",
        createdAt: new Date().toISOString(),
      },
    });
    const { adapter } = fakeAdapter(new Map());
    const result = await processReviewItem({
      connection: conn,
      emailId: "e1",
      acceptSender: false,
      adapter,
      extractionDeps: fakeExtractionDeps(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no longer");
  });
});

describe("ignoreReviewItem", () => {
  it("drops the item from the list and marks it review-ignored", async () => {
    const conn = connection();
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
    await createPendingItem(conn.id, "e1");

    expect(await ignoreReviewItem(conn.id, "e1")).toBe(true);
    expect((await logRow(conn.id, "e1"))?.outcome).toBe("review-ignored");
    expect(await listReviewItems(conn.id)).toEqual([]);
    // Already decided — a second ignore is a no-op.
    expect(await ignoreReviewItem(conn.id, "e1")).toBe(false);
  });
});
