import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearMimeCache,
  fastmailInboundDeps,
  processUnprocessedReceipts,
  receiptEmailData,
  type FastmailAdapter,
} from "~/lib/inbound-fastmail.server";
import {
  extractExpenseDate,
  type InboundDeps,
} from "~/lib/inbound-email.server";
import { normalizeAmount } from "~/lib/format";
import type { RawEmail } from "~/lib/fastmail.server";
import type { ExtractionResult } from "~/lib/receipt-ai.server";
import { deleteExpense, readExpenses } from "~/lib/db/expenses";
import type { Expense, ReceiptExpense } from "~/lib/types";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

/** A real 1x1 transparent PNG used as fake image/render output. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SENDER = "forwarder@example.com";
const PDF_BYTES = Buffer.from("%PDF-1.4 fake receipt bytes for testing\n%%EOF");

const ORIGINAL_EML = [
  "Date: Mon, 14 Jul 2025 09:30:00 -0700",
  "From: Merchant <no-reply@merchant.com>",
  "To: Forwarder <forwarder@example.com>",
  "Subject: Your receipt",
  "",
  "Thank you for your purchase.",
].join("\r\n");

function wrapBase64(input: Buffer): string {
  const b64 = input.toString("base64");
  return b64.replace(/(.{76})/g, "$1\r\n");
}

/**
 * A realistic forwarded receipt: multipart/mixed with an alternative
 * (text+html) body, a PDF receipt attachment, and the original message as an
 * `.eml` attachment (the pipeline reads its Date for the expense date).
 */
function receiptMime(): Buffer {
  return Buffer.from(
    [
      'From: "Forwarder" <forwarder@example.com>',
      "To: receipts@labnotes.org",
      "Subject: Fwd: Receipt from Merchant",
      "Date: Tue, 15 Jul 2025 10:00:00 -0700",
      "Message-ID: <fm-test-1@forwarder.example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="MIXED"',
      "",
      "--MIXED",
      'Content-Type: multipart/alternative; boundary="ALT"',
      "",
      "--ALT",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Begin forwarded message:",
      "",
      "From: Merchant <no-reply@merchant.com>",
      "Date: July 14, 2025 at 9:30:00 AM PDT",
      "Subject: Your receipt",
      "",
      "MERCHANT: Test Merchant",
      "TOTAL: 42.00",
      "--ALT",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><p>Begin forwarded message:</p><p><b>receipt html</b></p></body></html>",
      "--ALT--",
      "",
      "--MIXED",
      'Content-Type: application/pdf; name="receipt.pdf"',
      'Content-Disposition: attachment; filename="receipt.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(PDF_BYTES),
      "--MIXED",
      'Content-Type: message/rfc822; name="original.eml"',
      'Content-Disposition: attachment; filename="original.eml"',
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(ORIGINAL_EML)),
      "--MIXED--",
      "",
    ].join("\r\n"),
  );
}

function rawEmailOf(id: string): RawEmail {
  return {
    id,
    raw: receiptMime(),
    receivedAt: "2025-07-15T17:00:00Z",
    subject: "Fwd: Receipt from Merchant",
    from: "Forwarder <forwarder@example.com>",
    to: ["receipts@labnotes.org"],
    messageId: "<fm-test-1@forwarder.example.com>",
  };
}

/** Two receipts forwarded by the SAME unknown sender (one drain, two emails). */
function unknownSenderRawEmailOf(id: string, messageId: string): RawEmail {
  return {
    id,
    raw: Buffer.from(
      [
        "From: Stranger <stranger@evil.com>",
        "To: receipts@labnotes.org",
        "Subject: Fwd: Your receipt",
        `Message-ID: <${messageId}>`,
        "",
        "MERCHANT: Acme",
        "TOTAL: 9.99",
      ].join("\r\n"),
    ),
    receivedAt: "2025-07-15T17:00:00Z",
    subject: "Fwd: Your receipt",
    from: "Stranger <stranger@evil.com>",
    to: ["receipts@labnotes.org"],
    messageId: `<${messageId}>`,
  };
}

/** Fake adapter over an in-memory map of emails, recording JMAP calls. */
function recordingAdapter(emails: Map<string, RawEmail>): {
  adapter: FastmailAdapter;
  marked: string[];
  destroyed: string[];
  downloaded: string[];
} {
  const marked: string[] = [];
  const destroyed: string[] = [];
  const downloaded: string[] = [];
  const adapter: FastmailAdapter = {
    rawEmail: async (id) => {
      downloaded.push(id);
      const email = emails.get(id);
      if (!email) throw new Error(`unknown email ${id}`);
      return email;
    },
    // Model the real semantics: already-marked emails drop out of the query.
    unprocessedReceiptIds: async (limit) =>
      [...emails.keys()].filter((id) => !marked.includes(id)).slice(0, limit),
    markProcessed: async (id) => {
      marked.push(id);
    },
    destroyEmail: async (id) => {
      destroyed.push(id);
    },
  };
  return { adapter, marked, destroyed, downloaded };
}

/** Deterministic fake "model": reads MERCHANT:/TOTAL: markers (like inbound.test.ts). */
function fakeExtract(text?: string): ExtractionResult {
  const t = text ?? "";
  const merchant = t.match(/MERCHANT:\s*([^\n]+)/i)?.[1]?.trim() ?? "";
  const amount = t.match(/TOTAL:\s*\$?([0-9]+(?:\.[0-9]{1,2})?)/i)?.[1] ?? "";
  return {
    isReceipt: t.includes("TOTAL:") || t.includes("MERCHANT:"),
    merchant,
    description: t.match(/DESCRIPTION:\s*([^\n]+)/i)?.[1]?.trim() ?? "",
    amount: normalizeAmount(amount),
    category: t.match(/CATEGORY:\s*([^\n]+)/i)?.[1]?.trim() ?? "",
    report: "",
    notes: "",
    currency: "",
    confidence: "high",
  };
}

/** Fake pipeline deps: everything canned, extraction via markers. The three
 * fetch collaborators are intentionally absent — the MIME bridge provides
 * them when spread underneath ({ ...bridgeDeps, ...fakeDeps() }). */
function fakeDeps(): Omit<
  InboundDeps,
  "fetchReceivedEmail" | "listAttachments" | "downloadAttachment"
> {
  return {
    classifyAttachment: async () => null,
    extractReceipt: async (input) => fakeExtract(input.text),
    extractFromImage: async () => ({
      result: fakeExtract(
        "MERCHANT: Photo Shop\nTOTAL: 5.00\nCATEGORY: office supplies",
      ),
      text: "",
      stored: { buffer: TINY_PNG, mime: "image/png" },
    }),
    renderReceiptImage: async () => TINY_PNG,
    renderEmailImage: async () => TINY_PNG,
    renderTextEmail: async () => TINY_PNG,
    sendReply: async () => {},
  };
}

/** Narrow expenses to a receipt with the given merchant (throws otherwise). */
function findReceipt(
  expenses: Expense[],
  merchant: string,
): ReceiptExpense | undefined {
  return expenses.find(
    (e): e is ReceiptExpense => e.type === "receipt" && e.merchant === merchant,
  );
}

const usedEmailIds: string[] = [];
const usedExpenseIds: string[] = [];

async function allowSender(accountId: string, address: string): Promise<void> {
  const normalized = address.toLowerCase();
  await testPrisma.inboundSender.createMany({
    data: [
      { accountId, address: normalized, createdAt: new Date().toISOString() },
    ],
    skipDuplicates: true,
  });
  await testPrisma.inboundSenderVerification.createMany({
    data: [
      { address: normalized, accountId, verifiedAt: new Date().toISOString() },
    ],
    skipDuplicates: true,
  });
}

beforeEach(async () => {
  clearMimeCache();
  await allowSender(TEST_ACCOUNT_ID, SENDER);
});

afterEach(async () => {
  for (const id of usedExpenseIds) {
    await deleteExpense(id, TEST_ACCOUNT_ID).catch(() => {});
  }
  usedExpenseIds.length = 0;
  if (usedEmailIds.length > 0) {
    await testPrisma.inboundEmail
      .deleteMany({ where: { emailId: { in: usedEmailIds } } })
      .catch(() => {});
    usedEmailIds.length = 0;
  }
  await testPrisma.inboundSender
    .deleteMany({ where: { accountId: TEST_ACCOUNT_ID, address: SENDER } })
    .catch(() => {});
  await testPrisma.inboundSenderVerification
    .deleteMany({ where: { accountId: TEST_ACCOUNT_ID, address: SENDER } })
    .catch(() => {});
});

describe("MIME bridge over FastMail", () => {
  const id = "fm-bridge-1";

  it("parses a raw email into the ReceivedEmail shape", async () => {
    const { adapter } = recordingAdapter(new Map([[id, rawEmailOf(id)]]));
    const deps = fastmailInboundDeps(adapter);
    const email = await deps.fetchReceivedEmail(id);

    expect(email.id).toBe(id);
    expect(email.from).toBe("Forwarder <forwarder@example.com>");
    expect(email.to).toEqual(["receipts@labnotes.org"]);
    expect(email.subject).toBe("Fwd: Receipt from Merchant");
    expect(email.html).toContain("receipt html");
    expect(email.text).toContain("MERCHANT: Test Merchant");
    expect(email.headers["date"]).toMatch(/15 Jul 2025/);
    expect(email.headers["message-id"]).toContain("fm-test-1");
    expect(email.created_at).toBe("2025-07-15T17:00:00Z");
    expect(email.message_id).toBe("<fm-test-1@forwarder.example.com>");
  });

  it("maps MIME attachments with stable ids and normalized content ids", async () => {
    const { adapter } = recordingAdapter(new Map([[id, rawEmailOf(id)]]));
    const deps = fastmailInboundDeps(adapter);
    const attachments = await deps.listAttachments(id);

    expect(attachments).toHaveLength(2);

    const pdf = attachments.find((a) => a.filename === "receipt.pdf");
    expect(pdf).toBeDefined();
    expect(pdf!.content_type).toBe("application/pdf");
    expect(pdf!.content_disposition).toBe("attachment");
    expect(pdf!.size).toBe(PDF_BYTES.length);
    expect(pdf!.id).toBe(`${id}:0`);

    const eml = attachments.find((a) => a.filename === "original.eml");
    expect(eml).toBeDefined();
    expect(eml!.content_type).toBe("message/rfc822");
    expect(eml!.content_disposition).toBe("attachment");
  });

  it("downloads an attachment's bytes by its meta id", async () => {
    const { adapter } = recordingAdapter(new Map([[id, rawEmailOf(id)]]));
    const deps = fastmailInboundDeps(adapter);
    const attachments = await deps.listAttachments(id);
    const pdf = attachments.find((a) => a.filename === "receipt.pdf")!;

    expect(await deps.downloadAttachment(pdf)).toEqual(PDF_BYTES);
  });

  it("feeds the pipeline's expense-date logic from the .eml attachment", async () => {
    const { adapter } = recordingAdapter(new Map([[id, rawEmailOf(id)]]));
    const deps = fastmailInboundDeps(adapter);
    const email = await deps.fetchReceivedEmail(id);
    const attachments = await deps.listAttachments(id);
    const eml = attachments.find((a) => a.filename === "original.eml")!;
    const emlText = (await deps.downloadAttachment(eml)).toString("utf8");

    expect(extractExpenseDate(email, emlText)).toBe("2025-07-14");
  });

  it("builds EmailReceivedData with the JMAP id as the idempotency key", async () => {
    const { adapter } = recordingAdapter(new Map([[id, rawEmailOf(id)]]));
    const data = await receiptEmailData(id, adapter);

    expect(data.email_id).toBe(id);
    expect(data.from).toBe("Forwarder <forwarder@example.com>");
    expect(data.created_at).toBe("2025-07-15T17:00:00Z");
    expect(data.message_id).toBe("<fm-test-1@forwarder.example.com>");
    expect(data.subject).toBe("Fwd: Receipt from Merchant");
  });

  it("downloads and parses the blob once per email (shared cache)", async () => {
    const { adapter, downloaded } = recordingAdapter(
      new Map([[id, rawEmailOf(id)]]),
    );
    const deps = fastmailInboundDeps(adapter);

    const [email, attachments] = await Promise.all([
      deps.fetchReceivedEmail(id),
      deps.listAttachments(id),
    ]);
    expect(email.subject).toBeTruthy();
    expect(attachments).toHaveLength(2);
    expect(downloaded).toEqual([id]); // one blob download, not two
  });
});

describe("processUnprocessedReceipts", () => {
  it("marks before processing and destroys on success", async () => {
    const id = "fm-proc-1";
    const { adapter, marked, destroyed } = recordingAdapter(
      new Map([[id, rawEmailOf(id)]]),
    );
    const deps = fastmailInboundDeps(adapter);
    // The pipeline needs the bridge for fetch/list/download, but the model
    // must be faked (no DeepSeek in tests). The fixture's receipt.pdf makes
    // this the attachment path, so the fake extractFromImage result wins.
    const pipelineDeps: InboundDeps = { ...deps, ...fakeDeps() };

    const result = await processUnprocessedReceipts({
      adapter,
      deps: pipelineDeps,
    });

    expect(result).toEqual({ processed: 1, failed: 0, destroyed: 1 });
    expect(marked).toEqual([id]); // mark-before-process
    expect(destroyed).toEqual([id]);

    // The expense really was created (from the attachment path).
    const expenses = await readExpenses(TEST_ACCOUNT_ID);
    const created = findReceipt(expenses, "Photo Shop");
    expect(created).toBeDefined();
    expect(created!.amount).toBe("5.00");
    usedExpenseIds.push(created!.id);

    // And the inbound_emails row records the outcome (idempotency key).
    const row = await testPrisma.inboundEmail.findUnique({
      where: { emailId: id },
    });
    expect(row?.status).toBe("created");
    usedEmailIds.push(id);
  });

  it("does not destroy when the pipeline reports an error", async () => {
    const id = "fm-proc-2";
    // A body with no receipt markers → "Not a receipt" → status error.
    const notReceipt: RawEmail = {
      ...rawEmailOf(id),
      raw: Buffer.from(
        [
          'From: "Forwarder" <forwarder@example.com>',
          "To: receipts@labnotes.org",
          "Subject: No receipt here",
          "Date: Tue, 15 Jul 2025 10:00:00 -0700",
          "Message-ID: <fm-test-2@forwarder.example.com>",
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Just a note, no receipt content at all.",
        ].join("\r\n"),
      ),
      subject: "No receipt here",
    };
    const { adapter, destroyed } = recordingAdapter(
      new Map([[id, notReceipt]]),
    );
    const deps = fastmailInboundDeps(adapter);
    const pipelineDeps: InboundDeps = { ...deps, ...fakeDeps() };

    const result = await processUnprocessedReceipts({
      adapter,
      deps: pipelineDeps,
    });

    expect(result).toEqual({ processed: 0, failed: 1, destroyed: 0 });
    expect(destroyed).toEqual([]); // stays in the folder for review
  });

  it("does not destroy when processing throws", async () => {
    const id = "fm-proc-3";
    const { adapter, destroyed } = recordingAdapter(
      new Map([[id, rawEmailOf(id)]]),
    );
    const deps = fastmailInboundDeps(adapter);
    const pipelineDeps: InboundDeps = {
      ...deps,
      ...fakeDeps(),
      fetchReceivedEmail: async () => {
        throw new Error("JMAP went away");
      },
    };

    const result = await processUnprocessedReceipts({
      adapter,
      deps: pipelineDeps,
    });

    expect(result).toEqual({ processed: 0, failed: 1, destroyed: 0 });
    expect(destroyed).toEqual([]);
  });

  it("is idempotent — a re-fired push for the same email becomes a duplicate", async () => {
    const id = "fm-proc-4";
    const { adapter, marked, destroyed } = recordingAdapter(
      new Map([[id, rawEmailOf(id)]]),
    );
    const deps = fastmailInboundDeps(adapter);
    const pipelineDeps: InboundDeps = { ...deps, ...fakeDeps() };

    const first = await processUnprocessedReceipts({
      adapter,
      deps: pipelineDeps,
    });
    expect(first.processed).toBe(1);
    const expenses1 = await readExpenses(TEST_ACCOUNT_ID);
    const created = findReceipt(expenses1, "Photo Shop")!;
    usedExpenseIds.push(created.id);

    // Simulate the destroy failing (or a concurrent push racing the mark):
    // the email reappears unmarked and gets processed again.
    marked.splice(marked.indexOf(id), 1);
    const second = await processUnprocessedReceipts({
      adapter,
      deps: pipelineDeps,
    });
    // The DB row (status "created") short-circuits to "duplicate", no new
    // expense — but the email still gets destroyed.
    expect(second).toEqual({ processed: 1, failed: 0, destroyed: 1 });
    expect(destroyed).toEqual([id, id]);

    const expenses2 = await readExpenses(TEST_ACCOUNT_ID);
    expect(
      expenses2.filter(
        (e): e is ReceiptExpense =>
          e.type === "receipt" && e.merchant === "Photo Shop",
      ),
    ).toHaveLength(1);
    usedEmailIds.push(id);
  });

  it("suppresses a second reply to the same sender within one drain", async () => {
    // Loop guard: the reply circuit breaker must cap replies per sender per
    // drain, so a runaway mail (a bounce or autoresponder variant that slips
    // past the guards) can't fill the Sent folder. Two unknown-sender emails
    // in one drain → exactly one "sender not recognized" reply.
    const sent: { to: string; subject: string }[] = [];
    const { adapter, destroyed } = recordingAdapter(
      new Map([
        ["fm-loop-1", unknownSenderRawEmailOf("fm-loop-1", "loop-1@evil.com")],
        ["fm-loop-2", unknownSenderRawEmailOf("fm-loop-2", "loop-2@evil.com")],
      ]),
    );
    const deps = fastmailInboundDeps(adapter);
    const pipelineDeps: InboundDeps = {
      ...deps,
      ...fakeDeps(),
      sendReply: async (input) => {
        sent.push({ to: input.to, subject: input.subject });
      },
    };

    const result = await processUnprocessedReceipts({
      adapter,
      deps: pipelineDeps,
    });

    expect(result).toEqual({ processed: 2, failed: 0, destroyed: 2 });
    expect(sent).toHaveLength(1); // duplicate reply suppressed
    expect(sent[0]!.subject).toContain("sender not recognized");
    expect(destroyed).toHaveLength(2);
  });

  it("drains multiple batches when the backlog exceeds the batch size", async () => {
    const emails = new Map<string, RawEmail>();
    for (let i = 0; i < 3; i++) {
      const id = `fm-batch-${i}`;
      emails.set(id, {
        ...rawEmailOf(id),
        messageId: `<fm-batch-${i}@forwarder.example.com>`,
      });
    }
    const { adapter, destroyed } = recordingAdapter(emails);
    const deps = fastmailInboundDeps(adapter);
    const pipelineDeps: InboundDeps = { ...deps, ...fakeDeps() };

    const result = await processUnprocessedReceipts({
      adapter,
      deps: pipelineDeps,
      batchSize: 2,
    });

    expect(result).toEqual({ processed: 3, failed: 0, destroyed: 3 });
    expect(destroyed.sort()).toEqual([
      "fm-batch-0",
      "fm-batch-1",
      "fm-batch-2",
    ]);

    const expenses = await readExpenses(TEST_ACCOUNT_ID);
    const created = expenses.filter(
      (e): e is ReceiptExpense =>
        e.type === "receipt" && e.merchant === "Photo Shop",
    );
    usedExpenseIds.push(...created.map((e) => e.id));
    usedEmailIds.push(...emails.keys());
  });
});
