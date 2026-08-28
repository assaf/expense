import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  scanConnectionInbox,
  listReviewItems,
  listSupersededItems,
  listUncoveredCharges,
  ignoreReviewItem,
  processReviewItem,
  reviewSenderRulePattern,
} from "~/lib/email-review.server";
import { addEmailRule, matchEmailRule } from "~/lib/db/email-rules";
import { readExpenses } from "~/lib/db/expenses";
import { testPrisma, TEST_ACCOUNT_ID } from "./helpers/seedTestData";
import {
  fakeAdapter,
  fakeExtractionDeps,
  logRow,
  cleanupConnection,
  connection,
} from "./helpers/email-test-fixtures";

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

/**
 * Pins the scan window: fixture arrival dates (2026-07-01 and friends)
 * must stay inside the 90-day lookback whenever the suite runs.
 */
const SCAN_NOW = Date.parse("2026-07-15T00:00:00.000Z");

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

/** A receipt expense covering a charge (the merchant receipt that makes a
 * bank notification redundant). Distinct merchants so cleanup is safe.
 * `receivedAt` is the receipt EMAIL's arrival: a few minutes after the
 * charge's alerts, the timing the supersede matching pairs on.
 * `withEmail=false` simulates an expense with no email record behind it
 * (hand-entered, forwarded, or predating the arrival stamps). */
async function createCoveringExpense(
  connectionId: string,
  merchant: string,
  amount: string,
  date = "2026-07-01",
  receivedAt = "2026-07-01T10:05:00.000Z",
  withEmail = true,
): Promise<string> {
  const id = `exp-${Math.random().toString(36).slice(2)}`;
  await testPrisma.expense.create({
    data: {
      id,
      accountId: TEST_ACCOUNT_ID,
      _type: "receipt",
      date,
      report: "",
      category: "",
      description: "",
      amount,
      merchant,
      imageFile: "",
      imageMime: "",
      originalName: "",
      locations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  if (withEmail) {
    await testPrisma.emailProcessLog.create({
      data: {
        connectionId,
        emailId: id,
        fromAddress: `receipts@${merchant.toLowerCase().replace(/[^a-z]/g, "")}.example`,
        fromDisplay: `${merchant} <receipts@${merchant.toLowerCase().replace(/[^a-z]/g, "")}.example>`,
        subject: "Your receipt",
        matched: true,
        outcome: "created",
        expenseId: id,
        receivedAt,
        createdAt: receivedAt,
      },
    });
  }
  return id;
}

const NOTIFICATION_EMAILS = new Map<
  string,
  { from: string; subject: string; body: string }
>([
  [
    "n1",
    {
      from: "Capital One <capitalone@service.capitalone.com>",
      subject: "A new transaction was charged to your account",
      body: "A new transaction was charged to your account.\nAmount: $9.99",
    },
  ],
  [
    "n2",
    {
      from: "Capital One <capitalone@service.capitalone.com>",
      subject: "A new international transaction was charged to your account",
      body: "Transaction amount: 1,500 JPY\nAmount: $9.99",
    },
  ],
]);

describe("scanConnectionInbox", () => {
  let conn: ReturnType<typeof connection>;

  beforeEach(async () => {
    conn = connection();
    await cleanupConnection();
    await testPrisma.expense.deleteMany({
      where: {
        accountId: TEST_ACCOUNT_ID,
        merchant: { in: ["z.ai", "Second Cup", "Extra Space Storage"] },
      },
    });
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
      now: SCAN_NOW,
    });

    expect(result.added).toBe(2);
    expect(result.pending).toBe(2);
    expect(result.finished).toBe(true);
    expect(result.atCap).toBe(false); // small mailbox: everything was scanned
    // One bounded query: the 90-day window ending at SCAN_NOW, newest
    // first, 500 messages max.
    expect(queries).toEqual([
      { afterIso: "2026-04-16T00:00:00.000Z", limit: 500, descending: true },
    ]);

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
    // so tie order is unspecified; compare as a set).
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
      now: SCAN_NOW,
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
          reason: "bounce",
          createdAt: new Date().toISOString(),
        },
        {
          connectionId: conn.id,
          emailId: "e2",
          fromAddress: conn.emailAddress,
          subject: "Your receipt",
          matched: false,
          outcome: "ignored",
          reason: "self",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    // Even though every email here looks like a receipt, the ignored reasons
    // are decisive: the scan must not re-offer them.
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
      now: SCAN_NOW,
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
      now: SCAN_NOW,
    });

    const items = await listReviewItems(conn.id);
    expect(items.map((i) => i.emailId).sort()).toEqual(["e1", "e2"]);
    // The upsert flipped both rows to pending-review.
    expect((await logRow(conn.id, "e1"))?.outcome).toBe("pending-review");
    expect((await logRow(conn.id, "e2"))?.outcome).toBe("pending-review");
  });

  it("caps the batch at 500 emails within the 90-day window", async () => {
    // 505 emails inside the window plus one from before it: the adapter
    // honours the query, so 504 in-window messages are offered and the
    // batch stops at 500. Non-receipt bodies keep the pass cheap (no
    // rows written); the query shape and counters are what's pinned.
    const emails = new Map<
      string,
      { from: string; subject: string; body: string; receivedAt?: string }
    >();
    for (let i = 0; i < 505; i++) {
      emails.set(`e${i}`, {
        from: `Sender ${i} <noreply@store${i}.example>`,
        subject: "Big sale this week",
        body: "Unsubscribe now to stop receiving these.",
      });
    }
    emails.set("stale", {
      from: "Old <noreply@old.example>",
      subject: "Your receipt",
      body: "MERCHANT: Old\nTOTAL: 1.00",
      receivedAt: "2026-03-01T10:00:00.000Z",
    });
    const { adapter, queries } = fakeAdapter(emails);

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(queries).toEqual([
      { afterIso: "2026-04-16T00:00:00.000Z", limit: 500, descending: true },
    ]);
    expect(result.scanned).toBe(500); // 504 in the window, capped at 500
    expect(result.added).toBe(0);
    expect(result.finished).toBe(true);
    expect(result.atCap).toBe(true); // mailbox has more; older mail not offered
  });

  it("offers only email from the last 90 days", async () => {
    const { adapter } = fakeAdapter(
      new Map([
        [
          "recent",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Your receipt",
            body: "MERCHANT: Apple\nTOTAL: 9.99",
          },
        ],
        [
          "stale",
          {
            from: "Old <noreply@old.example>",
            subject: "Your receipt",
            body: "MERCHANT: Old\nTOTAL: 1.00",
            receivedAt: "2026-03-01T10:00:00.000Z",
          },
        ],
      ]),
    );

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    // The stale receipt predates the window and is never examined.
    expect(result.scanned).toBe(1);
    const items = await listReviewItems(conn.id);
    expect(items.map((i) => i.emailId)).toEqual(["recent"]);
  });

  it("supersedes a notification when an imported receipt covers the charge", async () => {
    const expenseId = await createCoveringExpense(conn.id, "z.ai", "9.99");
    const { adapter } = fakeAdapter(NOTIFICATION_EMAILS);

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.added).toBe(0);
    expect(result.superseded).toBe(2);
    expect(result.pending).toBe(0);
    // Neither notification is offered; both are logged as superseded (with
    // the covering expense's id, so the review page can link to it) and the
    // drain never re-offers them either.
    expect(await listReviewItems(conn.id)).toEqual([]);
    for (const id of ["n1", "n2"]) {
      const row = await logRow(conn.id, id);
      expect(row?.outcome).toBe("review-ignored");
      expect(row?.reason).toBe("superseded");
      expect(row?.expenseId).toBe(expenseId);
    }
    // The audit trail on the review page: what arrived, and what covered it.
    const superseded = await listSupersededItems(conn.id);
    expect(superseded.map((s) => s.emailId)).toEqual(["n1", "n2"]);
    expect(superseded[0]?.expenseId).toBe(expenseId);
  });

  it("offers an uncovered notification: card-only merchants have no other receipt", async () => {
    const { adapter } = fakeAdapter(
      new Map([
        [
          "n1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "A new transaction was charged to your account.\nAmount: $149.00",
          },
        ],
      ]),
    );

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.added).toBe(1);
    expect(result.superseded).toBe(0);
    const items = await listReviewItems(conn.id);
    expect(items.map((i) => i.emailId)).toEqual(["n1"]);
  });

  it("drops a pending notification on the next scan once the receipt is imported", async () => {
    // First scan: no covering expense yet, so the notification is listed.
    const { adapter } = fakeAdapter(NOTIFICATION_EMAILS);
    const first = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });
    expect(first.pending).toBe(2);

    // The user processes the merchant receipt (here: directly seeded).
    await createCoveringExpense(conn.id, "z.ai", "9.99");

    const second = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });
    expect(second.superseded).toBe(2);
    expect(second.pending).toBe(0);
    expect(await listReviewItems(conn.id)).toEqual([]);
    expect((await logRow(conn.id, "n1"))?.outcome).toBe("review-ignored");
  });

  it("restores a superseded notification when its covering receipt is deleted", async () => {
    const expenseId = await createCoveringExpense(conn.id, "z.ai", "9.99");
    const { adapter } = fakeAdapter(NOTIFICATION_EMAILS);
    const first = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });
    expect(first.superseded).toBe(2);

    await testPrisma.expense.deleteMany({
      where: { id: expenseId },
    });

    const second = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });
    // The cover is gone, so the notifications return to the list: a wrong
    // supersede self-heals instead of losing the record.
    expect(second.superseded).toBe(0);
    expect(second.pending).toBe(2);
    expect((await logRow(conn.id, "n1"))?.outcome).toBe("pending-review");
  });

  it("never re-offers a notification the user ignored by hand", async () => {
    await createCoveringExpense(conn.id, "z.ai", "9.99");
    await testPrisma.emailProcessLog.create({
      data: {
        connectionId: conn.id,
        emailId: "n1",
        fromAddress: "capitalone@service.capitalone.com",
        fromDisplay: "Capital One <capitalone@service.capitalone.com>",
        subject: "A new transaction was charged to your account",
        matched: false,
        outcome: "review-ignored",
        reason: "user ignored",
        receivedAt: "2026-07-01T10:00:00.000Z",
        createdAt: new Date().toISOString(),
      },
    });
    const { adapter } = fakeAdapter(NOTIFICATION_EMAILS);

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    // n1 stays the user's decision even though a cover exists; n2 (no row)
    // is superseded normally.
    expect(result.superseded).toBe(1);
    expect(result.pending).toBe(0);
    expect((await logRow(conn.id, "n1"))?.reason).toBe("user ignored");
  });

  it("supersedes only the covered burst when two same-amount charges share a day", async () => {
    // Two $9.99 charges hours apart, one receipt: the receipt covers its
    // own charge's burst only; the other charge's notification is its
    // only record and must stay on the list.
    await createCoveringExpense(conn.id, "z.ai", "9.99");
    const { adapter } = fakeAdapter(
      new Map([
        [
          "a1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "A new transaction was charged to your account.\nAmount: $9.99",
            receivedAt: "2026-07-01T09:00:00.000Z",
          },
        ],
        [
          "b1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "A new transaction was charged to your account.\nAmount: $9.99",
            receivedAt: "2026-07-01T15:00:00.000Z",
          },
        ],
      ]),
    );

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.superseded).toBe(1);
    expect(result.pending).toBe(1);
    expect((await logRow(conn.id, "a1"))?.outcome).toBe("review-ignored");
    expect((await logRow(conn.id, "b1"))?.outcome).toBe("pending-review");
  });

  it("supersedes both bursts when each charge has its receipt", async () => {
    await createCoveringExpense(conn.id, "z.ai", "9.99");
    await createCoveringExpense(
      conn.id,
      "Second Cup",
      "9.99",
      "2026-07-01",
      "2026-07-01T15:10:00.000Z",
    );
    const { adapter } = fakeAdapter(
      new Map([
        [
          "a1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "Amount: $9.99",
            receivedAt: "2026-07-01T09:00:00.000Z",
          },
        ],
        [
          "b1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "Amount: $9.99",
            receivedAt: "2026-07-01T15:00:00.000Z",
          },
        ],
      ]),
    );

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.superseded).toBe(2);
    expect(result.pending).toBe(0);
  });

  it("treats same-amount notifications within minutes as one charge (one burst)", async () => {
    // The z.ai shape: a domestic and an international alert for the same
    // charge, moments apart. One receipt covers the whole burst.
    await createCoveringExpense(conn.id, "z.ai", "9.99");
    const { adapter } = fakeAdapter(
      new Map([
        [
          "a1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "Amount: $9.99",
            receivedAt: "2026-07-01T09:00:00.000Z",
          },
        ],
        [
          "a2",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject:
              "A new international transaction was charged to your account",
            body: "Transaction amount: 1,500 JPY\nAmount: $9.99",
            receivedAt: "2026-07-01T09:01:00.000Z",
          },
        ],
      ]),
    );

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.superseded).toBe(2);
    expect(result.pending).toBe(0);
  });

  it("keeps a notification whose receipt email arrived more than two hours late", async () => {
    // The charge's receipt lagged past the pairing window; the
    // notification stays listed rather than risk pairing it with an
    // unrelated later receipt.
    await createCoveringExpense(
      conn.id,
      "z.ai",
      "9.99",
      "2026-07-01",
      "2026-07-01T13:00:00.000Z",
    );
    const { adapter } = fakeAdapter(NOTIFICATION_EMAILS);

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.superseded).toBe(0);
    expect(result.pending).toBe(2);
  });

  it("keeps a notification whose matching receipt email arrived before it", async () => {
    // A receipt landing before a burst belongs to an earlier charge.
    await createCoveringExpense(
      conn.id,
      "z.ai",
      "9.99",
      "2026-07-01",
      "2026-07-01T07:00:00.000Z",
    );
    const { adapter } = fakeAdapter(NOTIFICATION_EMAILS);

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.superseded).toBe(0);
    expect(result.pending).toBe(2);
  });

  it("keeps a notification when the matching expense has no email record", async () => {
    // Hand-entered, forwarded through the receipts address, or imported
    // before arrivals were stamped: no arrival time, no pairing.
    await createCoveringExpense(
      conn.id,
      "z.ai",
      "9.99",
      "2026-07-01",
      "2026-07-01T10:05:00.000Z",
      false,
    );
    const { adapter } = fakeAdapter(NOTIFICATION_EMAILS);

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.superseded).toBe(0);
    expect(result.pending).toBe(2);
  });

  it("pairs a receipt with the burst it follows, not an earlier one", async () => {
    // Two charges twenty minutes apart; only the second sent a receipt.
    // The receipt follows ITS OWN charge's alerts, so the first charge's
    // notification stays listed even though the receipt arrived well
    // within two hours of it too.
    await createCoveringExpense(
      conn.id,
      "Second Cup",
      "9.99",
      "2026-07-01",
      "2026-07-01T09:25:00.000Z",
    );
    const { adapter } = fakeAdapter(
      new Map([
        [
          "a1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "Amount: $9.99",
            receivedAt: "2026-07-01T09:00:00.000Z",
          },
        ],
        [
          "b1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "Amount: $9.99",
            receivedAt: "2026-07-01T09:20:00.000Z",
          },
        ],
      ]),
    );

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.superseded).toBe(1);
    expect(result.pending).toBe(1);
    expect((await logRow(conn.id, "a1"))?.outcome).toBe("pending-review");
    expect((await logRow(conn.id, "b1"))?.outcome).toBe("review-ignored");
  });

  it("keeps the second charge listed when two same-amount charges are minutes apart", async () => {
    // The tight case: two $9.99 charges ten minutes apart, one receipt.
    // The receipt belongs to the first charge (it arrived before the
    // second charge even happened), so the second notification stays.
    await createCoveringExpense(
      conn.id,
      "z.ai",
      "9.99",
      "2026-07-01",
      "2026-07-01T09:05:00.000Z",
    );
    const { adapter } = fakeAdapter(
      new Map([
        [
          "a1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "Amount: $9.99",
            receivedAt: "2026-07-01T09:00:00.000Z",
          },
        ],
        [
          "b1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "Amount: $9.99",
            receivedAt: "2026-07-01T09:10:00.000Z",
          },
        ],
      ]),
    );

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.superseded).toBe(1);
    expect(result.pending).toBe(1);
    expect((await logRow(conn.id, "a1"))?.outcome).toBe("review-ignored");
    expect((await logRow(conn.id, "b1"))?.outcome).toBe("pending-review");
  });

  it("keeps a notification when the matching expense came from a notification", async () => {
    // The Extra Space charge was processed from its own notification;
    // that expense is its record, not a cover for a sibling $149
    // notification about a different charge later the same day.
    const expenseId = await createCoveringExpense(
      conn.id,
      "Extra Space Storage",
      "149.00",
      "2026-07-01",
      "2026-07-01T08:05:00.000Z",
    );
    await testPrisma.emailProcessLog.create({
      data: {
        connectionId: conn.id,
        emailId: "processed-notification",
        fromAddress: "capitalone@service.capitalone.com",
        fromDisplay: "Capital One <capitalone@service.capitalone.com>",
        subject: "A new transaction was charged to your account",
        matched: true,
        outcome: "created",
        expenseId,
        receivedAt: "2026-07-01T08:00:00.000Z",
        createdAt: new Date().toISOString(),
      },
    });
    const { adapter } = fakeAdapter(
      new Map([
        [
          "b1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "Amount: $149.00",
            receivedAt: "2026-07-01T15:00:00.000Z",
          },
        ],
      ]),
    );

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.superseded).toBe(0);
    expect(result.pending).toBe(1);
    expect((await logRow(conn.id, "b1"))?.outcome).toBe("pending-review");
  });

  it("lists uncovered charges and flips covered ones to superseded (feed)", async () => {
    const { adapter } = fakeAdapter(
      new Map([
        [
          "a1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "Amount: $9.99",
            receivedAt: "2026-07-01T09:00:00.000Z",
          },
        ],
        [
          "b1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "Amount: $149.00",
            receivedAt: "2026-07-01T15:00:00.000Z",
          },
        ],
      ]),
    );
    // First scan: both charges uncovered.
    const first = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });
    expect(first.pending).toBe(2);

    // The 9.99 charge gets its receipt; the 149 charge stays card-only.
    await createCoveringExpense(
      conn.id,
      "z.ai",
      "9.99",
      "2026-07-01",
      "2026-07-01T09:05:00.000Z",
    );

    const feed = await listUncoveredCharges(conn);
    // The covered charge dropped off the feed AND moved to the audit; the
    // card-only charge remains, with its amount.
    expect(feed.map((c) => c.emailId)).toEqual(["b1"]);
    expect(feed[0]?.amount).toBe("149.00");
    expect((await logRow(conn.id, "a1"))?.reason).toBe("superseded");
    expect((await logRow(conn.id, "a1"))?.expenseId).not.toBeNull();
    const superseded = await listSupersededItems(conn.id);
    expect(superseded.map((s) => s.emailId)).toEqual(["a1"]);
  });

  it("lists only notification rows in the feed (receipts are not charges)", async () => {
    // A plain receipt pending (not a notification) must not appear as a
    // charge with no expense.
    await testPrisma.emailProcessLog.create({
      data: {
        connectionId: conn.id,
        emailId: "r1",
        fromAddress: "no_reply@email.apple.com",
        fromDisplay: "Apple <no_reply@email.apple.com>",
        subject: "Your receipt",
        matched: false,
        outcome: "pending-review",
        receivedAt: "2026-07-01T10:00:00.000Z",
        createdAt: new Date().toISOString(),
      },
    });
    const { adapter } = fakeAdapter(
      new Map([
        [
          "n1",
          {
            from: "Capital One <capitalone@service.capitalone.com>",
            subject: "A new transaction was charged to your account",
            body: "Amount: $12.00",
            receivedAt: "2026-07-01T10:00:00.000Z",
          },
        ],
      ]),
    );
    await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    const feed = await listUncoveredCharges(conn);
    expect(feed.map((c) => c.emailId)).toEqual(["n1"]);
  });

  it("keeps a notification whose charge matches no expense on that date", async () => {
    // Same amount, different day: too weak to supersede on (the charge
    // may be a different one), so the notification stays on the list.
    await createCoveringExpense(conn.id, "z.ai", "9.99", "2026-06-30");
    const { adapter } = fakeAdapter(NOTIFICATION_EMAILS);

    const result = await scanConnectionInbox(conn, {
      adapter,
      extractionDeps: fakeExtractionDeps(),
      budgetMs: 5000,
      now: SCAN_NOW,
    });

    expect(result.superseded).toBe(0);
    expect(result.pending).toBe(2);
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
    // Processed receipts persist otherwise; with the image fingerprint,
    // a previous test's identical image reads as a duplicate.
    await testPrisma.expense.deleteMany({
      where: { accountId: TEST_ACCOUNT_ID },
    });
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
    // No rule matched, but the review flow processed it anyway (no rule gate).
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
    // The shared fixture renders every body to the same constant PNG; e2
    // needs its own bytes, or the image fingerprint refuses it as a
    // duplicate of e1 before the sender-rule flow ever runs.
    const differentRender = async () => Buffer.from("apple-image-bytes");
    const extractionDeps2 = {
      ...fakeExtractionDeps(),
      renderReceiptImage: differentRender,
      renderEmailImage: differentRender,
      renderTextEmail: differentRender,
    };
    const result2 = await processReviewItem({
      connection: conn,
      emailId: "e2",
      acceptSender: true,
      adapter: adapter2,
      extractionDeps: extractionDeps2,
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
    // Already decided: a second ignore is a no-op.
    expect(await ignoreReviewItem(conn.id, "e1")).toBe(false);
  });
});
