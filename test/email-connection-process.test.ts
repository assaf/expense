import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import PostalMime from "postal-mime";
import {
  coalesceDrain,
  drainEmailConnection,
  drainWalkFloorMs,
  processConnectionEmail,
  connectionInboundDeps,
  type ConnectionMailAdapter,
  type OwnerEmail,
} from "~/lib/email-connection-process.server";
import { FASTMAIL_AUTHSERV } from "~/lib/mime-inbound.server";
import { buildRfc822Message } from "~/lib/email-mime.server";
import { readImage } from "~/lib/images.server";
import type * as EmailConnectionMailModule from "~/lib/email-connection-mail.server";
import type * as EmailLogModule from "~/lib/db/email-log";
import type * as EmailRulesModule from "~/lib/db/email-rules";
import { readStaleClaimArrivals, writeEmailLogRow } from "~/lib/db/email-log";
import { addEmailRule, removeEmailRule } from "~/lib/db/email-rules";
import { readExpenses } from "~/lib/db/expenses";
import { db } from "~/lib/prisma.server";
import { fromIso, fromIsoOrNull, toIso } from "~/lib/db/wire";
import { testPrisma } from "./helpers/seedTestData";
import {
  fakeAdapter,
  fakeExtractionDeps,
  logRow,
  cleanupConnection,
  connection,
  summary,
  type TestConnection,
} from "./helpers/email-test-fixtures";

/**
 * The connected-account processing pipeline: fake mailbox adapter + fake
 * extraction collaborators over the real test database (rules, process log,
 * counters, expenses).
 */

const gmailMocks = vi.hoisted(() => ({
  // The gmail branch of mailClientFor routes owner notifications here;
  // the real importer has its own test file.
  gmailSendConnectionEmailToOwner: vi.fn(async () => {}),
  gmailMailAdapter: vi.fn(),
}));

vi.mock("~/lib/gmail.server", () => gmailMocks);

const mailMocks = vi.hoisted(() => ({
  // Owner notifications are written back over JMAP; the drain tests are
  // offline, so the delivery is stubbed (its own module has its own
  // coverage). learnAuthservId is scripted per test.
  deliverConnectionEmailToInbox: vi.fn(async () => true),
  learnAuthservId: vi.fn(async () => undefined as string | undefined),
}));

vi.mock("~/lib/email-connection-mail.server", async (importOriginal) => ({
  ...(await importOriginal<typeof EmailConnectionMailModule>()),
  deliverConnectionEmailToInbox: mailMocks.deliverConnectionEmailToInbox,
  learnAuthservId: mailMocks.learnAuthservId,
}));

const rulesMocks = vi.hoisted(() => ({ failMatch: false }));

// The rule gate is a DB read, and it can fail: a missing table made it
// throw in production, between the claim and the pipeline's own try. The
// tests below drive that failure on demand; everything else in the file
// uses the real store.
vi.mock("~/lib/db/email-rules", async (importOriginal) => {
  const actual = await importOriginal<typeof EmailRulesModule>();
  return {
    ...actual,
    matchEmailRule: async (
      ...args: Parameters<typeof actual.matchEmailRule>
    ) => {
      if (rulesMocks.failMatch) {
        throw new Error('relation "public.email_rule_removals" does not exist');
      }
      return actual.matchEmailRule(...args);
    },
  };
});

const logMocks = vi.hoisted(() => ({
  // Spied, not replaced: the drain's pre-work read of the process log is
  // once per mailbox batch, and this pins that count. It was once per email
  // (Sentry EXPENSE-1F, the `pg-pool.connect` N+1), which cost a pooled
  // round trip per email before the batch began any work.
  readEmailLogSnapshots: vi.fn(),
  // Set to an error to make the drain's batched process-log read throw it,
  // so the stage label and the preserved cause can be asserted.
  readError: null as Error | null,
}));

vi.mock("~/lib/db/email-log", async (importOriginal) => {
  const actual = await importOriginal<typeof EmailLogModule>();
  return {
    ...actual,
    readEmailLogSnapshots: (
      ...args: Parameters<typeof actual.readEmailLogSnapshots>
    ) => {
      logMocks.readEmailLogSnapshots(...args);
      if (logMocks.readError) throw logMocks.readError;
      return actual.readEmailLogSnapshots(...args);
    },
  };
});

const mocks = vi.hoisted(() => ({
  // The tests inject this as sendToOwner (the `adapters` arg to
  // processConnectionEmail); it is a spy, not the real JMAP delivery.
  notifyOwner: vi.fn(async (..._args: unknown[]) => true),
}));

/**
 * Covers the fixture emails' fixed 2026-07-01 arrivals no matter when the
 * suite runs: the fixture adapter now honours the drain's `afterIso`
 * window, and the default 3-day lookback would filter them out against
 * the real clock.
 */
const FIXTURE_LOOKBACK_MS =
  Date.now() - Date.parse("2026-07-01T10:00:00.000Z") + 60_000;

function depsFor(
  adapter: ConnectionMailAdapter,
  connectionId: string,
  authservIds: string[] = [FASTMAIL_AUTHSERV],
) {
  return connectionInboundDeps(
    connectionId,
    authservIds,
    adapter,
    fakeExtractionDeps(),
  );
}

describe("processConnectionEmail", () => {
  let conn: TestConnection;

  beforeEach(async () => {
    conn = connection();
    await cleanupConnection();
    // Processed receipts persist otherwise; with the image fingerprint, a
    // previous test's identical image reads as a real duplicate.
    await testPrisma.expense.deleteMany({
      where: { accountId: conn.accountId },
    });
    await testPrisma.emailConnection.create({
      data: {
        id: conn.id,
        accountId: conn.accountId,
        provider: conn.provider,
        emailAddress: conn.emailAddress,
        remoteAccountId: conn.remoteAccountId,
        tokenEnc: conn.tokenEnc,
        createdAt: conn.createdAt,
      },
    });
    await testPrisma.emailRule.deleteMany({
      where: { accountId: conn.accountId, source: "forward" },
    });
    // The rule-gate failure spy is per-test; reset it for every one.
    rulesMocks.failMatch = false;
    mocks.notifyOwner.mockClear();
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
          await mocks.notifyOwner(email);
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
    expect(mocks.notifyOwner).toHaveBeenCalledTimes(1);
    const sent = mocks.notifyOwner.mock.calls[0]![0] as {
      to: string;
      subject: string;
    };
    expect(sent.subject).toContain("Receipt accepted");
    // Logged as partial (category unknown under local extraction).
    expect((await logRow(conn.id, "e1"))?.outcome).toBe("partial");
  });

  it("shows the stored receipt image inline in the owner's confirmation", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter } = fakeAdapter(
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
          await mocks.notifyOwner(email);
        },
      },
    );
    expect(result.status).toBe("partial");
    const expenseId = "expenseId" in result ? result.expenseId : "";
    const sent = mocks.notifyOwner.mock.calls[0]![0] as OwnerEmail;

    // The owner's confirmation carries their STORED image (the original
    // email already sits in their Inbox), and the HTML references it by
    // Content-ID: the client renders the receipt in place of listing a file
    // to open, which is what makes the mail scannable at a glance.
    const raw = buildRfc822Message({
      fromName: "",
      fromEmail: conn.emailAddress,
      to: conn.emailAddress,
      subject: sent.subject,
      html: sent.html,
      text: sent.text,
      attachments: sent.attachments,
    });
    const parsed = await PostalMime.parse(raw);
    const image = parsed.attachments[0]!;
    expect(image.mimeType).toMatch(/^image\//);
    expect(image.disposition).toBe("inline");
    const cid = parsed.html?.match(/src="cid:([^"]+)"/)?.[1];
    expect(cid).toBeTruthy();
    expect(image.contentId).toBe(`<${cid}>`);

    // And the part carries the expense's own image, not a placeholder.
    const created = (await readExpenses(conn.accountId)).find(
      (e) => e.id === expenseId,
    );
    const stored = await readImage(
      conn.accountId,
      created?.type === "receipt" ? created.imageFile : "",
    );
    const bytes =
      typeof image.content === "string"
        ? Buffer.from(image.content, "base64")
        : Buffer.from(new Uint8Array(image.content));
    expect(stored && bytes.equals(stored.buffer)).toBe(true);
  });

  it("refuses to import when the delivered message fails authentication (S2-2)", async () => {
    // INB-SPOOF-1 parity: the receipts-by-email pipeline requires a passing,
    // From-aligned Authentication-Results stamp from the mail host. This
    // pipeline only matched a rule, so a forged From that matched one imported
    // a fake expense and moved the mail to Trash.
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
    const deps = depsFor(adapter, conn.id);
    const result = await processConnectionEmail(
      conn,
      summary("e1", "Apple <no_reply@email.apple.com>", "Your receipt"),
      {
        ...deps,
        // What the mail host stamped on delivery: neither verdict aligns with
        // the domain in From.
        fetchReceivedEmail: async (id: string) => ({
          ...(await deps.fetchReceivedEmail(id)),
          authResults: [
            "mx.messagingengine.com; dkim=fail header.d=email.apple.com; spf=fail smtp.mailfrom=evil.example",
          ],
        }),
      },
      {
        moveToTrash: (id) => adapter.moveToTrash(id),
        sendToOwner: async (email) => {
          await mocks.notifyOwner(email);
        },
      },
    );
    expect(result).toEqual({
      status: "ignored",
      reason: "failed authentication",
    });
    // Nothing imported, nothing trashed, nobody notified: the mail stays in the
    // Inbox and can still be imported deliberately from review.
    expect(trashed).toEqual([]);
    expect(await readExpenses(conn.accountId)).toHaveLength(0);
    expect(mocks.notifyOwner).not.toHaveBeenCalled();
  });

  it("skips the second copy of the same receipt and leaves it in the Inbox", async () => {
    // Cross-pipeline overlap: the same receipt exists in the Inbox AND as
    // the user's forward to the receipts address. The duplicate guard
    // skips the second import entirely: one expense, one confirmation,
    // and the duplicate copy stays in the Inbox untouched.
    await addEmailRule({
      accountId: "",
      sender: "dedupco.com",
      source: "seed",
    });
    const { adapter, trashed } = fakeAdapter(
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
        await mocks.notifyOwner(email);
      },
    };

    const first = await processConnectionEmail(
      conn,
      summary("e1", "DedupCo <no_reply@dedupco.com>", "Your receipt"),
      depsFor(adapter, conn.id),
      adapters,
    );
    expect(first.status).toBe("partial");
    expect(mocks.notifyOwner).toHaveBeenCalledTimes(1);

    const second = await processConnectionEmail(
      conn,
      summary("e2", "DedupCo <no_reply@dedupco.com>", "Your receipt"),
      depsFor(adapter, conn.id),
      adapters,
    );
    // The duplicate guard skips the import: no second expense, no second
    // confirmation, and the copy stays in the Inbox (recoverable).
    expect(second.status).toBe("ignored");
    expect((second as { reason: string }).reason).toBe("duplicate");
    // Only the first copy was trashed (imported); the duplicate stays.
    expect(trashed).toEqual(["e1"]);
    expect(mocks.notifyOwner).toHaveBeenCalledTimes(1);
    expect((await logRow(conn.id, "e2"))?.reason).toBe(
      "duplicate of a recent import",
    );
    const expenses = await readExpenses(conn.accountId);
    expect(
      expenses.filter((e) => e.type === "receipt" && e.merchant === "Dedupco"),
    ).toHaveLength(1);
  });

  it("ignores emails with no matching rule and leaves them in the Inbox", async () => {
    const { adapter, trashed } = fakeAdapter(new Map());
    const result = await processConnectionEmail(
      conn,
      summary("e2", "newsletter@random.com", "Weekly digest"),
      depsFor(adapter, conn.id),
      {
        moveToTrash: (id) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("ignored");
    expect(trashed).toEqual([]);
    expect(mocks.notifyOwner).not.toHaveBeenCalled();
    expect((await logRow(conn.id, "e2"))?.outcome).toBe("ignored");
    expect(
      (await readExpenses(conn.accountId)).find(
        (e) => e.type === "receipt" && e.merchant === "Digest",
      ),
    ).toBeUndefined();
  });

  it("ignores mail from a sender the workspace turned off, recoverable in review", async () => {
    // apple.com is a pre-selected sender; turning it off has to stop the
    // drain filing its mail, and the row it leaves must stay recoverable so
    // the Inbox review scan offers the sender again.
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    await removeEmailRule({
      accountId: conn.accountId,
      sender: "apple.com",
    });
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
          await mocks.notifyOwner(email);
        },
      },
    );
    expect(result).toEqual({ status: "ignored", reason: "no rule" });
    expect(trashed).toEqual([]);
    expect(await readExpenses(conn.accountId)).toHaveLength(0);
    expect(mocks.notifyOwner).not.toHaveBeenCalled();
    const row = await logRow(conn.id, "e1");
    expect(row?.outcome).toBe("ignored");
    expect(row?.reason).toBeNull();
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
    expect((result as { reason: string }).reason).toBe("no receipt signal");
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

  it("ignores newsletters with prices even from rule-matched senders", async () => {
    await addEmailRule({
      accountId: "",
      sender: "apple.com",
      source: "seed",
    });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "e10",
          {
            from: "Apple <news@email.apple.com>",
            subject: "Run the latest models for open-weight prices",
            body: "Now only $0.20 on AWS. Amazon.com has deals.",
          },
        ],
      ]),
    );
    const deps = depsFor(adapter, conn.id);
    const extractReceipt = vi.fn((input) => deps.extractReceipt(input));
    deps.extractReceipt = extractReceipt;
    const result = await processConnectionEmail(
      conn,
      summary(
        "e10",
        "Apple <news@email.apple.com>",
        "Run the latest models for open-weight prices",
      ),
      deps,
      {
        moveToTrash: (id: string) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("ignored");
    expect((result as { reason: string }).reason).toBe("no receipt signal");
    expect(trashed).toEqual([]);
    expect(extractReceipt).not.toHaveBeenCalled();
    expect((await logRow(conn.id, "e10"))?.outcome).toBe("ignored");
  });

  it("ignores bank notification senders (Capital One alerts are not receipts)", async () => {
    await addEmailRule({
      accountId: "",
      sender: "capitalone.com",
      source: "seed",
    });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "e9",
          {
            from: "capitalone@notification.capitalone.com",
            subject: "It looks like you were charged twice",
            body: "Amount: $20.00",
          },
        ],
      ]),
    );
    const deps = depsFor(adapter, conn.id);
    const extractReceipt = vi.fn((input) => deps.extractReceipt(input));
    deps.extractReceipt = extractReceipt;
    const result = await processConnectionEmail(
      conn,
      summary(
        "e9",
        "capitalone@notification.capitalone.com",
        "It looks like you were charged twice",
      ),
      deps,
      {
        moveToTrash: (id: string) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("ignored");
    expect((result as { reason: string }).reason).toBe(
      "bank notification sender",
    );
    expect(trashed).toEqual([]);
    expect(extractReceipt).not.toHaveBeenCalled();
    expect((await logRow(conn.id, "e9"))?.outcome).toBe("ignored");
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

  it("resolves the claim when the rule gate throws, instead of stranding it", async () => {
    // The production incident: a missing table made matchEmailRule throw
    // between the claim and the pipeline's own try. The row stayed on
    // `processing` forever, which the drain reads as a finished email and
    // the review list never offers. Inside the try it lands on `error`,
    // which review does offer.
    rulesMocks.failMatch = true;
    const { adapter, trashed } = fakeAdapter(new Map());
    const result = await processConnectionEmail(
      conn,
      summary("e1", "Apple <no_reply@email.apple.com>", "Your receipt"),
      depsFor(adapter, conn.id),
      {
        moveToTrash: (id) => adapter.moveToTrash(id),
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("error");
    const row = await logRow(conn.id, "e1");
    expect(row?.outcome).toBe("error");
    expect(String(row?.error)).toContain("email_rule_removals");
    // Nothing imported, nothing trashed: the mail stays in the Inbox.
    expect(trashed).toEqual([]);
    expect(await readExpenses(conn.accountId)).toHaveLength(0);
  });

  it("reclaims a claim a dead worker left behind", async () => {
    // A killed function or a crash leaves the row claimed with nobody
    // working on it. The drain has to pick the email up again instead of
    // reading the claim as "done".
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    await testPrisma.emailProcessLog.create({
      data: {
        connectionId: conn.id,
        emailId: "e1",
        fromAddress: "no_reply@email.apple.com",
        subject: "Your receipt",
        matched: false,
        outcome: "processing",
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    });
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
        sendToOwner: async () => {},
      },
    );
    expect(result.status).toBe("partial");
    expect((await logRow(conn.id, "e1"))?.outcome).toBe("partial");
    expect(trashed).toEqual(["e1"]);
  });

  it("leaves a live claim alone", async () => {
    // The other side of that cutoff: a claim written moments ago belongs
    // to a request that is still working, so no second drain may take it.
    await testPrisma.emailProcessLog.create({
      data: {
        connectionId: conn.id,
        emailId: "e1",
        fromAddress: "no_reply@email.apple.com",
        subject: "Your receipt",
        matched: false,
        outcome: "processing",
        createdAt: new Date().toISOString(),
      },
    });
    const { adapter } = fakeAdapter(new Map());
    const result = await processConnectionEmail(
      conn,
      summary("e1", "Apple <no_reply@email.apple.com>", "Your receipt"),
      depsFor(adapter, conn.id),
      {
        moveToTrash: async () => {},
        sendToOwner: async () => {},
      },
    );
    expect(result).toEqual({ status: "ignored", reason: "already processed" });
    expect((await logRow(conn.id, "e1"))?.outcome).toBe("processing");
  });
});

describe("drainEmailConnection", () => {
  let conn: TestConnection;

  beforeEach(async () => {
    conn = connection();
    await cleanupConnection();
    await testPrisma.expense.deleteMany({
      where: { accountId: conn.accountId },
    });
    await testPrisma.emailConnection.create({
      data: {
        id: conn.id,
        accountId: conn.accountId,
        provider: conn.provider,
        emailAddress: conn.emailAddress,
        remoteAccountId: conn.remoteAccountId,
        tokenEnc: conn.tokenEnc,
        createdAt: conn.createdAt,
      },
    });
    await testPrisma.emailRule.deleteMany({
      where: { accountId: conn.accountId, source: "forward" },
    });
    // The rule-gate failure spy is per-test; reset it for every one.
    rulesMocks.failMatch = false;
    mocks.notifyOwner.mockClear();
    // The batched log read is counted per test (see logMocks).
    logMocks.readEmailLogSnapshots.mockClear();
    logMocks.readError = null;
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

    const first = await drainEmailConnection(conn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });
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
    const second = await drainEmailConnection(conn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });
    expect(second.evaluated).toBe(0);
    const after = await testPrisma.emailConnection.findUnique({
      where: { id: conn.id },
    });
    expect(after?.receivedCount).toBe(2);
    expect(after?.processedCount).toBe(1);
  });

  it("re-offers an email whose claim went stale while it sat in the Inbox", async () => {
    // A drain that died mid-flight leaves its row on `processing` with the
    // mail still in the Inbox. The fresh filter used to read ANY row as a
    // finished email, which made processConnectionEmail's claim takeover
    // unreachable from the only caller that runs it: the receipt was never
    // filed and nothing ever looked at the email again.
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    await testPrisma.emailProcessLog.create({
      data: {
        connectionId: conn.id,
        emailId: "s1",
        fromAddress: "no_reply@email.apple.com",
        subject: "Receipt 1",
        matched: false,
        outcome: "processing",
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "s1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt 1",
            body: "MERCHANT: Apple\nTOTAL: 3.50\nCATEGORY: office supplies",
          },
        ],
      ]),
    );

    const result = await drainEmailConnection(conn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });

    expect(result.evaluated).toBe(1);
    expect(trashed).toEqual(["s1"]);
    const row = await logRow(conn.id, "s1");
    expect(row?.outcome === "created" || row?.outcome === "partial").toBe(true);
  });

  it("reads the process log once per batch, not once per email", async () => {
    // One mailbox batch of four, three of them new. d1 is already settled.
    await testPrisma.emailProcessLog.create({
      data: {
        connectionId: conn.id,
        emailId: "d1",
        fromAddress: "no_reply@email.apple.com",
        subject: "Receipt 1",
        matched: false,
        outcome: "ignored",
        createdAt: new Date().toISOString(),
      },
    });
    const { adapter } = fakeAdapter(
      new Map([
        [
          "d1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt 1",
            body: "MERCHANT: Apple\nTOTAL: 3.50",
          },
        ],
        [
          "d2",
          {
            from: "newsletter@random.com",
            subject: "Digest 2",
            body: "nothing to see",
          },
        ],
        [
          "d3",
          {
            from: "newsletter@random.com",
            subject: "Digest 3",
            body: "nothing to see",
          },
        ],
        [
          "d4",
          {
            from: "newsletter@random.com",
            subject: "Digest 4",
            body: "nothing to see",
          },
        ],
      ]),
    );

    const result = await drainEmailConnection(conn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });

    // The settled email stays out; the other three are evaluated, and the
    // whole batch cost one log read.
    expect(result.evaluated).toBe(3);
    expect(logMocks.readEmailLogSnapshots).toHaveBeenCalledTimes(1);
    expect(logMocks.readEmailLogSnapshots.mock.calls[0]).toEqual([
      conn.id,
      ["d1", "d2", "d3", "d4"],
    ]);
  });

  it("writes the batch's counters once, not once per email", async () => {
    // One pooled round trip per email, for a number the list page shows
    // (Sentry EXPENSE-1F). The counter UPDATEs are the drain's only calls
    // through db.runtime().execute, so counting them pins the batch: three
    // emails, one write per counter.
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter } = fakeAdapter(
      new Map([
        [
          "c1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt 1",
            body: "MERCHANT: Apple\nTOTAL: 3.50\nCATEGORY: office supplies",
          },
        ],
        [
          "c2",
          {
            from: "newsletter@random.com",
            subject: "Digest 2",
            body: "nothing to see",
          },
        ],
        [
          "c3",
          {
            from: "newsletter@random.com",
            subject: "Digest 3",
            body: "nothing to see",
          },
        ],
      ]),
    );
    const runtime = db.runtime();
    const execute = runtime.execute.bind(runtime);
    let writes = 0;
    const spy = vi.spyOn(db, "runtime").mockReturnValue(
      new Proxy(runtime, {
        get(target, prop, receiver) {
          if (prop !== "execute") return Reflect.get(target, prop, receiver);
          return (...args: unknown[]) => {
            writes += 1;
            return execute(...(args as Parameters<typeof execute>));
          };
        },
      }),
    );

    try {
      const result = await drainEmailConnection(conn, {
        adapter,
        batchSize: 10,
        lookbackMs: FIXTURE_LOOKBACK_MS,
      });
      expect(result.evaluated).toBe(3);
    } finally {
      spy.mockRestore();
    }

    expect(writes).toBe(2);
    const row = await testPrisma.emailConnection.findUnique({
      where: { id: conn.id },
    });
    expect(row?.receivedCount).toBe(3);
    expect(row?.processedCount).toBe(1);
  });

  it("names the step that failed, and keeps the cause for the console", async () => {
    // The push route reports "drain failed" and nothing else, and in
    // production the raw message was scrubbed to [Filtered] (EXPENSE-1B), so
    // the step is the only thing that says where it died.
    const { adapter } = fakeAdapter(new Map());
    const upstream = new Error(
      "JMAP /api/query returned HTTP 502: upstream unavailable",
    );
    const failing = {
      ...adapter,
      inboxEmailSummaries: async () => {
        throw upstream;
      },
    };

    const thrown = await drainEmailConnection(conn, {
      adapter: failing,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    }).catch((err: unknown) => err);

    expect((thrown as Error).message).toBe(
      "[email-connections] reading the mailbox failed: Error: JMAP /api/query returned HTTP 502: upstream unavailable",
    );
    expect((thrown as Error).cause).toBe(upstream);
  });

  it("names the step when the batched process-log read fails", async () => {
    // The batched read is the call the N+1 fix introduced, so it is the one
    // whose failures this stage labelling exists to place.
    const upstream = new Error("canceling statement due to pool timeout");
    logMocks.readError = upstream;
    const { adapter } = fakeAdapter(
      new Map([
        [
          "d1",
          {
            from: "newsletter@random.com",
            subject: "Digest",
            body: "nothing to see",
          },
        ],
      ]),
    );

    const thrown = await drainEmailConnection(conn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    }).catch((err: unknown) => err);

    expect((thrown as Error).message).toBe(
      "[email-connections] reading the process log failed: Error: canceling statement due to pool timeout",
    );
    expect((thrown as Error).cause).toBe(upstream);
  });

  it("names the step when the batch's counter write fails", async () => {
    const upstream = new Error(
      "could not serialize access due to concurrent update",
    );
    const runtime = db.runtime();
    const spy = vi.spyOn(db, "runtime").mockReturnValue(
      new Proxy(runtime, {
        get(target, prop, receiver) {
          if (prop !== "execute") return Reflect.get(target, prop, receiver);
          return () => Promise.reject(upstream);
        },
      }),
    );

    try {
      const { adapter } = fakeAdapter(
        new Map([
          [
            "d1",
            {
              from: "newsletter@random.com",
              subject: "Digest",
              body: "nothing to see",
            },
          ],
        ]),
      );
      const thrown = await drainEmailConnection(conn, {
        adapter,
        batchSize: 10,
        lookbackMs: FIXTURE_LOOKBACK_MS,
      }).catch((err: unknown) => err);

      expect((thrown as Error).message).toBe(
        "[email-connections] counting the batch failed: Error: could not serialize access due to concurrent update",
      );
      expect((thrown as Error).cause).toBe(upstream);
    } finally {
      spy.mockRestore();
    }
  });

  it("names the step when the connection's credential cannot be resolved", async () => {
    // The drain's setup runs before the batch loop, so these two calls were
    // the stage-less throws the labelling was meant to remove: a revoked or
    // half-configured connection reported "drain failed" with nothing
    // pointing at credential resolution.
    const thrown = await drainEmailConnection(
      { ...conn, provider: "jmap", sessionUrl: "" },
      { batchSize: 10, lookbackMs: FIXTURE_LOOKBACK_MS },
    ).catch((err: unknown) => err);

    expect((thrown as Error).message).toBe(
      "[email-connections] resolving the credential failed: Error: This connection has no server URL; reconnect it.",
    );
  });

  it("names the step when the delivery authentication stamp cannot be read", async () => {
    // The other setup call: a JMAP connection with no pinned stamp learns it
    // from the mailbox, so an unreachable mailbox fails here rather than in
    // the batch loop — with nothing to say so.
    const upstream = new Error("JMAP /api/emailchanges query failed");
    mailMocks.learnAuthservId.mockRejectedValueOnce(upstream);

    const thrown = await drainEmailConnection(
      {
        ...conn,
        provider: "jmap",
        sessionUrl: "https://jmap.example.test/session",
        authservId: "",
      },
      { batchSize: 10, lookbackMs: FIXTURE_LOOKBACK_MS },
    ).catch((err: unknown) => err);

    expect((thrown as Error).message).toBe(
      "[email-connections] reading the delivery authentication stamp failed: Error: JMAP /api/emailchanges query failed",
    );
    expect((thrown as Error).cause).toBe(upstream);
  });

  it("stamps the email's arrival on the row it files", async () => {
    // Inbox review pairs a bank notification's charge with a receipt by the
    // RECEIPT's arrival (alerts land within a minute of the charge). A
    // receipt the drain filed has to carry that stamp, or the pairing never
    // sees it and the notification for an already-filed charge stays on the
    // review list.
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter } = fakeAdapter(
      new Map([
        [
          "r1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt 1",
            body: "MERCHANT: Apple\nTOTAL: 3.50\nCATEGORY: office supplies",
          },
        ],
      ]),
    );

    await drainEmailConnection(conn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });

    // Read through the app's own client (the test shim parses this column in
    // local time): the pairing compares one DB read against another, and the
    // timestamp codec is wire text, so decode it the way the app does.
    const row = await db.orm.public.EmailProcessLog.where({
      connectionId: conn.id,
      emailId: "r1",
    })
      .select("receivedAt")
      .first();
    expect(row?.receivedAt).toBeTruthy();
    expect(toIso(row?.receivedAt ?? "")).toBe("2026-07-01T10:00:00.000Z");
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
      ...connectionInboundDeps(
        conn.id,
        [FASTMAIL_AUTHSERV],
        adapter,
        fakeExtractionDeps(),
      ),
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
    const drain = await drainEmailConnection(conn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });
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
      lookbackMs: FIXTURE_LOOKBACK_MS,
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
      lookbackMs: FIXTURE_LOOKBACK_MS,
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

  it("drains a gmail connection through the same pipeline", async () => {
    // provider: "gmail" selects the Gmail branch of mailClientFor: the
    // injected (fake) mailbox adapter overrides the transport, and owner
    // notifications must flow through the Gmail importer, not the JMAP
    // delivery. Everything else (rules, dedupe, counters, Trash) is
    // provider-agnostic.
    const gmailConn = { ...conn, provider: "gmail" };
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "gm1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt 1",
            body: "MERCHANT: Apple\nTOTAL: 9.25\nCATEGORY: office supplies",
          },
        ],
      ]),
    );
    const result = await drainEmailConnection(gmailConn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });
    expect(result.created + result.partial).toBe(1);
    expect(trashed).toContain("gm1");
    const row = await testPrisma.emailConnection.findUnique({
      where: { id: conn.id },
    });
    expect(row?.receivedCount).toBe(1);
    expect(row?.processedCount).toBe(1);
  });

  it("drains a generic JMAP connection through the same pipeline", async () => {
    // A JMAP connection whose pinned delivery stamp carries a passing clause
    // aligned with the From domain: the receipt imports and the mail is
    // trashed, exactly like the Fastmail path.
    const jmapConn = {
      ...conn,
      provider: "jmap",
      sessionUrl: "https://mail.example.com/.well-known/jmap",
      authservId: "mail.example.com" as string | null,
    };
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "jm1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt",
            body: "MERCHANT: Apple\nTOTAL: 3.50\nCATEGORY: office supplies",
            authResults: "mail.example.com; dkim=pass header.d=email.apple.com",
          },
        ],
      ]),
    );
    const result = await drainEmailConnection(jmapConn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });
    expect(result.created + result.partial).toBe(1);
    expect(trashed).toEqual(["jm1"]);
  });

  it("learns and pins the delivery stamp on the first drain of an unpinned JMAP connection", async () => {
    const jmapConn = {
      ...conn,
      provider: "jmap",
      sessionUrl: "https://mail.example.com/.well-known/jmap",
      authservId: null as string | null,
    };
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    mailMocks.learnAuthservId.mockResolvedValue("mail.example.com");
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "jm2",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt",
            body: "MERCHANT: Apple\nTOTAL: 4.25\nCATEGORY: office supplies",
            authResults: "mail.example.com; dkim=pass header.d=email.apple.com",
          },
        ],
      ]),
    );
    const result = await drainEmailConnection(jmapConn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });
    // The learned stamp is trusted for this same tick.
    expect(result.created + result.partial).toBe(1);
    expect(trashed).toEqual(["jm2"]);
    expect(mailMocks.learnAuthservId).toHaveBeenCalledWith(
      {
        sessionUrl: "https://mail.example.com/.well-known/jmap",
        authorization: "fmu1-conn-tok",
      },
      "jmap-1",
    );
    const row = await testPrisma.emailConnection.findUnique({
      where: { id: conn.id },
    });
    expect(row?.authservId).toBe("mail.example.com");
    mailMocks.learnAuthservId.mockReset();
  });

  it("skips the drain when no delivery stamp can be learned", async () => {
    // Fail closed: with no stamp to trust, evaluating an empty chain would
    // read as "legacy transport" and open the sender-authentication gate.
    const jmapConn = {
      ...conn,
      provider: "jmap",
      sessionUrl: "https://mail.example.com/.well-known/jmap",
      authservId: null as string | null,
    };
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    mailMocks.learnAuthservId.mockResolvedValue(undefined);
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "jm3",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt",
            body: "MERCHANT: Apple\nTOTAL: 5.00\nCATEGORY: office supplies",
          },
        ],
      ]),
    );
    const result = await drainEmailConnection(jmapConn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });
    expect(result).toEqual({
      evaluated: 0,
      created: 0,
      partial: 0,
      ignored: 0,
      failed: 0,
    });
    expect(trashed).toEqual([]);
    const row = await testPrisma.emailConnection.findUnique({
      where: { id: conn.id },
    });
    expect(row?.authservId).toBeNull();
    mailMocks.learnAuthservId.mockReset();
  });

  it("ignores mail whose passing stamp does not align with the sender", async () => {
    const jmapConn = {
      ...conn,
      provider: "jmap",
      sessionUrl: "https://mail.example.com/.well-known/jmap",
      authservId: "mail.example.com" as string | null,
    };
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "jm4",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt",
            body: "MERCHANT: Apple\nTOTAL: 6.00\nCATEGORY: office supplies",
            authResults: "mail.example.com; dkim=pass header.d=attacker.test",
          },
        ],
      ]),
    );
    const result = await drainEmailConnection(jmapConn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });
    expect(result.created + result.partial).toBe(0);
    expect(result.ignored).toBe(1);
    expect(trashed).toEqual([]);
    expect(await logRow(conn.id, "jm4")).toMatchObject({
      outcome: "ignored",
      reason: "failed authentication",
    });
  });

  it("stops before evaluating anything when the time budget is already spent", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "b1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt 1",
            body: "MERCHANT: Apple\nTOTAL: 1.00\nCATEGORY: office supplies",
          },
        ],
        [
          "b2",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt 2",
            body: "MERCHANT: Apple\nTOTAL: 2.00\nCATEGORY: office supplies",
          },
        ],
        [
          "b3",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt 3",
            body: "MERCHANT: Apple\nTOTAL: 3.00\nCATEGORY: office supplies",
          },
        ],
      ]),
    );

    const result = await drainEmailConnection(conn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
      // Already spent: the loop must stop before the first email, so nothing
      // is half-processed (the inner budget check would only stop mid-batch).
      timeBudgetMs: -1,
    });

    expect(result).toEqual({
      evaluated: 0,
      created: 0,
      partial: 0,
      ignored: 0,
      failed: 0,
    });
    expect(trashed).toEqual([]);
    expect(
      await testPrisma.emailProcessLog.count({
        where: { connectionId: conn.id },
      }),
    ).toBe(0);
  });

  it("keeps the counts of the emails it evaluated before the budget ran out", async () => {
    // The mid-batch exit is the flush that matters: without it every batch
    // the budget cuts short would leave the connection under-reporting the
    // work it actually did. Skewing the clock from the first Trash move
    // expires the budget after one email instead of before the batch starts.
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    let skewMs = 0;
    const realNow = Date.now;
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow.call(Date) + skewMs);

    try {
      const { adapter, trashed } = fakeAdapter(
        new Map([
          [
            "b1",
            {
              from: "Apple <no_reply@email.apple.com>",
              subject: "Receipt 1",
              body: "MERCHANT: Apple\nTOTAL: 1.00\nCATEGORY: office supplies",
            },
          ],
          [
            "b2",
            {
              from: "Apple <no_reply@email.apple.com>",
              subject: "Receipt 2",
              body: "MERCHANT: Apple\nTOTAL: 2.00\nCATEGORY: office supplies",
            },
          ],
        ]),
      );
      const skewed = {
        ...adapter,
        moveToTrash: async (id: string) => {
          await adapter.moveToTrash(id);
          skewMs = 60_000;
        },
      };

      const result = await drainEmailConnection(conn, {
        adapter: skewed,
        batchSize: 10,
        lookbackMs: FIXTURE_LOOKBACK_MS,
      });

      expect(result.evaluated).toBe(1);
      expect(trashed).toEqual(["b1"]);
      const row = await testPrisma.emailConnection.findUnique({
        where: { id: conn.id },
      });
      expect(row?.receivedCount).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("files the expense but reports failure when the Trash move fails", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const { adapter, trashed } = fakeAdapter(
      new Map([
        [
          "t1",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt 1",
            body: "MERCHANT: Apple\nTOTAL: 7.25\nCATEGORY: office supplies",
          },
        ],
      ]),
    );
    // A Trash move that fails after the expense is saved keeps the mail in
    // the Inbox; the row prevents a duplicate on the next drain.
    adapter.moveToTrash = async () => {
      throw new Error("trash exploded");
    };
    mailMocks.deliverConnectionEmailToInbox.mockClear();

    const result = await drainEmailConnection(conn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });

    expect(
      await testPrisma.expense.count({ where: { accountId: conn.accountId } }),
    ).toBe(1);
    expect(trashed).toEqual([]);
    expect(mailMocks.deliverConnectionEmailToInbox).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(result.created + result.partial).toBe(0);
  });

  it.fails("KNOWN GAP S2-2: an A-R chain empty after the authserv-id filter still imports", async () => {
    // A pinned JMAP connection trusts only its own delivery stamp. A message
    // whose ONLY Authentication-Results header carries an untrusted
    // authserv-id is filtered out, leaving an empty chain the gate reads as
    // a legacy transport and allows — so the message imports. This asserts
    // the safe outcome (no expense): it.fails keeps the suite green while
    // the gap is open, and turns red once the gate fails closed.
    const jmapConn = {
      ...conn,
      provider: "jmap",
      sessionUrl: "https://mail.example.com/.well-known/jmap",
      authservId: "mail.example.com" as string | null,
    };
    await addEmailRule({
      accountId: "",
      sender: "apple.com",
      source: "seed",
    });
    const { adapter } = fakeAdapter(
      new Map([
        [
          "s2",
          {
            from: "Apple <no_reply@email.apple.com>",
            subject: "Receipt",
            body: "MERCHANT: Apple\nTOTAL: 8.00\nCATEGORY: office supplies",
            authResults:
              "mx.untrusted.example; dkim=pass header.d=email.apple.com",
          },
        ],
      ]),
    );

    await drainEmailConnection(jmapConn, {
      adapter,
      batchSize: 10,
      lookbackMs: FIXTURE_LOOKBACK_MS,
    });

    expect(
      await testPrisma.expense.count({
        where: { accountId: conn.accountId },
      }),
    ).toBe(0);
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

// The read that keeps a resumed walk from stepping over the claim its previous
// drain died holding. Not reachable through the drain in this file — every
// drain test injects an adapter, which by design never resumes — so the query
// is what gets pinned here: which rows count as stale, and in what order.
describe("readStaleClaimArrivals", () => {
  let conn: TestConnection;

  beforeEach(async () => {
    conn = connection();
    await cleanupConnection();
    await testPrisma.emailConnection.create({
      data: {
        id: conn.id,
        accountId: conn.accountId,
        provider: conn.provider,
        emailAddress: conn.emailAddress,
        remoteAccountId: conn.remoteAccountId,
        tokenEnc: conn.tokenEnc,
        createdAt: conn.createdAt,
      },
    });
  });

  /** A log row as a writer leaves it, with the arrival under the test's
   * control: the claim that outlives its worker is the only row the drain has
   * to look back for. */
  const seedRow = (
    emailId: string,
    outcome: string,
    createdAtIso: string,
    arrivalIso: string | null,
  ) =>
    writeEmailLogRow({
      connectionId: conn.id,
      emailId,
      create: {
        fromAddress: "receipts@example.com",
        subject: "seeded",
        matched: false,
        outcome,
        createdAt: fromIso(createdAtIso),
        receivedAt: fromIsoOrNull(arrivalIso),
      },
      onUniqueViolation: "throw",
    });

  it("returns the stale claims' arrivals, oldest first", async () => {
    const stale = "2026-07-15T11:00:00.000Z";
    await seedRow(
      "stale-later",
      "processing",
      stale,
      "2026-07-14T09:00:00.000Z",
    );
    await seedRow(
      "stale-earlier",
      "processing",
      stale,
      "2026-07-14T08:00:00.000Z",
    );
    await seedRow("stale-unrecorded", "processing", stale, null);
    // Fresh: the worker holding this claim may still be alive, so its email is
    // not the drain's to take over.
    await seedRow(
      "live",
      "processing",
      "2026-07-15T12:00:00.000Z",
      "2026-07-14T07:00:00.000Z",
    );
    // Decided, whatever its age.
    await seedRow("settled", "ignored", stale, "2026-07-14T06:00:00.000Z");

    const arrivals = await readStaleClaimArrivals(
      conn.id,
      "2026-07-15T11:50:00.000Z",
    );

    // The head is what the drain points its walk at, so the earliest arrival
    // has to lead.
    expect(arrivals.slice(0, 2)).toEqual([
      "2026-07-14T08:00:00.000Z",
      "2026-07-14T09:00:00.000Z",
    ]);
    // The third recorded no arrival: it places nothing on the mailbox's
    // timeline, and seeing it is what stops the drain narrowing at all.
    expect(arrivals).toHaveLength(3);
    expect(arrivals).toContain(null);
  });

  it("is empty when every row is fresh or already decided", async () => {
    await seedRow(
      "settled",
      "created",
      "2026-07-15T11:00:00.000Z",
      "2026-07-14T08:00:00.000Z",
    );
    await seedRow(
      "live",
      "processing",
      "2026-07-15T12:00:00.000Z",
      "2026-07-14T07:00:00.000Z",
    );
    expect(
      await readStaleClaimArrivals(conn.id, "2026-07-15T11:50:00.000Z"),
    ).toEqual([]);
  });
});

// Where a walk starts, and the one thing that could make resuming one skip
// mail. Pure on purpose: the drain that uses this needs a live mailbox, so the
// boundary is what gets pinned. The exact overlap is asserted rather than
// related, because it is the cushion that makes resuming lossless when the
// mailbox's `receivedAt` and this app's clock disagree.
describe("drainWalkFloorMs", () => {
  const NOW = Date.parse("2026-07-15T12:00:00.000Z");
  const LOOKBACK = 3 * 24 * 60 * 60 * 1000;
  const WINDOW_FLOOR = NOW - LOOKBACK;

  it("starts at the lookback floor when there is no resume point", () => {
    expect(
      drainWalkFloorMs({
        nowMs: NOW,
        lookbackMs: LOOKBACK,
        lastWalkStartMs: null,
        oldestStaleClaimMs: null,
      }),
    ).toBe(WINDOW_FLOOR);
  });

  it("starts just before the last completed walk, not at the last batch", () => {
    // Mail delivered while a walk ran can land behind its cursor, so the next
    // walk has to re-cover the interval the previous one ran over.
    const lastWalkStartMs = NOW - 30_000;
    expect(
      drainWalkFloorMs({
        nowMs: NOW,
        lookbackMs: LOOKBACK,
        lastWalkStartMs,
        oldestStaleClaimMs: null,
      }),
    ).toBe(lastWalkStartMs - 60_000);
  });

  it("pulls back to a stale claim sitting behind the resume point", () => {
    // The claim a killed drain left on "processing": the takeover is only
    // reachable if the walk offers that email again, so its arrival wins.
    const oldestStaleClaimMs = NOW - 20 * 60 * 1000;
    expect(
      drainWalkFloorMs({
        nowMs: NOW,
        lookbackMs: LOOKBACK,
        lastWalkStartMs: NOW - 30_000,
        oldestStaleClaimMs,
      }),
    ).toBe(oldestStaleClaimMs);
  });

  it("keeps the resume point when the stale claim is newer than it", () => {
    const lastWalkStartMs = NOW - 30 * 60 * 1000;
    expect(
      drainWalkFloorMs({
        nowMs: NOW,
        lookbackMs: LOOKBACK,
        lastWalkStartMs,
        oldestStaleClaimMs: NOW - 10 * 60 * 1000,
      }),
    ).toBe(lastWalkStartMs - 60_000);
  });

  it("narrows nothing for a claim that cannot be placed", () => {
    // The caller passes the window floor when a stale claim carries no arrival
    // time: it sits nowhere on the mailbox's timeline, so the walk keeps the
    // whole window rather than step over it.
    expect(
      drainWalkFloorMs({
        nowMs: NOW,
        lookbackMs: LOOKBACK,
        lastWalkStartMs: NOW - 30_000,
        oldestStaleClaimMs: WINDOW_FLOOR,
      }),
    ).toBe(WINDOW_FLOOR);
  });

  it("never starts earlier than the lookback floor", () => {
    // Neither an ancient resume point nor an ancient claim licenses a walk
    // longer than the window it is allowed to cover.
    expect(
      drainWalkFloorMs({
        nowMs: NOW,
        lookbackMs: LOOKBACK,
        lastWalkStartMs: NOW - 10 * LOOKBACK,
        oldestStaleClaimMs: NOW - 10 * LOOKBACK,
      }),
    ).toBe(WINDOW_FLOOR);
  });
});

// Fastmail delivers pushes in bursts (nine inside seven seconds on
// 2026-10-06), and each push used to re-walk the same already-evaluated
// window. These drive `coalesceDrain` directly: the drain itself needs a live
// mailbox, and every other test in this file passes options (its own adapter),
// which by design never coalesces.
describe("coalesceDrain", () => {
  /**
   * A run that reports when it was entered (`began`) and resolves only when
   * released. `began` is what the assertions await: the trailing run starts
   * a few microtasks after the run it follows settles, so counting ticks
   * would be a guess.
   */
  const gate = (label: string) => {
    let release: () => void = () => {};
    let announce: () => void = () => {};
    let started = 0;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      announce = resolve;
    });
    return {
      began,
      get started() {
        return started;
      },
      release,
      run: async (): Promise<string> => {
        started += 1;
        announce();
        await settled;
        return label;
      },
    };
  };

  it("collapses a burst into the run in flight plus one trailing run", async () => {
    const first = gate("in-flight");
    const second = gate("trailing");
    const runs = [() => first.run(), () => second.run()];
    const calls = [
      coalesceDrain("burst", runs[0]!),
      coalesceDrain("burst", runs[1]!),
      coalesceDrain("burst", runs[0]!),
      coalesceDrain("burst", runs[1]!),
    ];

    // One run so far: the second caller joined it instead of starting one.
    expect(first.started).toBe(1);
    expect(second.started).toBe(0);

    first.release();
    // The trailing run starts only after the one it follows has settled, which
    // is what keeps the coalescing lossless: its lookback window opens after
    // the mail that arrived during the first run.
    await second.began;
    expect(second.started).toBe(1);

    second.release();
    // The first caller keeps the run it started; the three that arrived during
    // it all share one trailing run, so a burst of four costs two drains.
    expect(await Promise.all(calls)).toEqual([
      "in-flight",
      "trailing",
      "trailing",
      "trailing",
    ]);
  });

  it("lets a rejected run still run the trailing drain", async () => {
    const boom = coalesceDrain("rejects", () =>
      Promise.reject(new Error("no")),
    );
    const trailing = coalesceDrain("rejects", () => Promise.resolve("ok"));
    await expect(boom).rejects.toThrow("no");
    expect(await trailing).toBe("ok");
  });

  it("starts fresh once both runs have settled", async () => {
    const first = gate("first");
    const opening = coalesceDrain("drains", () => first.run());
    first.release();
    await first.began;
    // Both runs are awaited, and in this order deliberately. The slot is
    // cleared by the LAST run standing, so awaiting `opening` before the
    // trailing one is scheduled would delete the slot early and turn this
    // into a different test. If the assertion below ever joined a run instead
    // of starting one it would return "first", not "second".
    const trailing = coalesceDrain("drains", () => first.run());
    await Promise.allSettled([opening, trailing]);
    expect(await coalesceDrain("drains", () => Promise.resolve("second"))).toBe(
      "second",
    );
  });
});
