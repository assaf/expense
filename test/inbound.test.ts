import { describe, it, expect, beforeEach, afterEach } from "vitest";
import sharp from "sharp";
import { normalizeAmount } from "~/lib/format";
import { extractEmailAddress } from "~/lib/validation";
import {
  processInboundEvent,
  parseDateString,
  extractDateFromForwardedText,
  extractDateFromEml,
  extractExpenseDate,
  scoreAttachment,
  pickReceiptAttachment,
  isPrivateHost,
  fetchRemoteImageImpl,
} from "~/lib/inbound-email.server";
import { matchCategory } from "~/lib/receipt-ai.server";
import type {
  InboundDeps,
  EmailReceivedData,
  ReceivedEmail,
  AttachmentMeta,
} from "~/lib/inbound-email.server";
import type { ExtractionResult } from "~/lib/receipt-ai.server";
import type { ProcessResult } from "~/lib/inbound-email.server";
import type { Expense, ReceiptExpense } from "~/lib/types";
import type { RenderTextEmailOptions } from "~/lib/email-render.server";
import {
  buildReceiptSvg,
  renderReceiptImage,
} from "~/lib/receipt-render.server";
import { htmlToText } from "~/lib/html-text";
import { parseJsonObject } from "~/lib/receipt-ai.server";
import { deleteExpense, readExpenses } from "~/lib/db/expenses";
import {
  TEST_ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
  testPrisma,
} from "./helpers/seedTestData";

/** A real 1x1 transparent PNG used as fake image/PDF render output. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SENDER = "forwarder@example.com";

/** Deterministic fake "model": reads MERCHANT:/TOTAL:/CATEGORY: markers. */
function fakeExtract(text?: string): ExtractionResult {
  const t = text ?? "";
  const merchant = t.match(/MERCHANT:\s*([^\n]+)/i)?.[1]?.trim() ?? "";
  const amount = t.match(/TOTAL:\s*\$?([0-9]+(?:\.[0-9]{1,2})?)/i)?.[1] ?? "";
  return {
    isReceipt: t.includes("TOTAL:") || t.includes("MERCHANT:"),
    merchant,
    description: t.match(/DESCRIPTION:\s*([^\n]+)/i)?.[1]?.trim() ?? "",
    amount: normalizeAmount(amount),
    currency: "USD",
    category: t.match(/CATEGORY:\s*([^\n]+)/i)?.[1]?.trim() ?? "",
    report: t.match(/REPORT:\s*([^\n]+)/i)?.[1]?.trim() ?? "",
    confidence: "high",
    notes: "",
  };
}

function receivedEmail(overrides: Partial<ReceivedEmail> = {}): ReceivedEmail {
  return {
    id: "email-1",
    from: `Forwarder <${SENDER}>`,
    to: ["receipts@labnotes.org"],
    subject: "Fwd: Receipt from Amazon",
    html: null,
    text: [
      "Begin forwarded message:",
      "",
      "From: Amazon <no-reply@amazon.com>",
      "Date: June 5, 2026 10:12:33 PDT",
      "Subject: Your order receipt",
      "",
      "MERCHANT: Amazon",
      "TOTAL: 42.50",
      "CATEGORY: office supplies",
    ].join("\n"),
    headers: { date: "Sat, 20 Jun 2026 09:00:00 -0700" },
    created_at: "2026-06-20T16:00:00.000Z",
    message_id: "<msg-1@example.com>",
    ...overrides,
  };
}

function eventData(
  overrides: Partial<EmailReceivedData> = {},
): EmailReceivedData {
  return {
    email_id: "email-1",
    created_at: "2026-06-20T16:00:00.000Z",
    from: `Forwarder <${SENDER}>`,
    to: ["receipts@labnotes.org"],
    bcc: [],
    cc: [],
    received_for: ["receipts@labnotes.org"],
    message_id: "<msg-1@example.com>",
    subject: "Fwd: Receipt from Amazon",
    attachments: [],
    ...overrides,
  };
}

function attachment(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id: "att-1",
    filename: "receipt.pdf",
    size: 12000,
    content_type: "application/pdf",
    content_disposition: "attachment",
    content_id: null,
    download_url: null,
    expires_at: null,
    ...overrides,
  };
}

/** Build fake deps: real renderReceiptImage (resvg + bundled font), everything else faked. */
function fakeDeps(): InboundDeps & {
  sent: {
    subject: string;
    html: string;
    to: string;
    attachments?: { content: string; filename: string }[];
  }[];
  downloads: AttachmentMeta[];
} {
  const sent: {
    subject: string;
    html: string;
    to: string;
    attachments?: { content: string; filename: string }[];
  }[] = [];
  const downloads: AttachmentMeta[] = [];
  const deps: InboundDeps = {
    fetchReceivedEmail: async (id) => receivedEmail({ id }),
    listAttachments: async () => [],
    downloadAttachment: async (meta) => {
      downloads.push(meta);
      return TINY_PNG;
    },
    classifyAttachment: async () => null,
    extractReceipt: async (input) => fakeExtract(input.text),
    extractFromImage: async () => ({
      result: fakeExtract(
        "MERCHANT: Photo Shop\nTOTAL: 5.00\nCATEGORY: office supplies",
      ),
      text: "MERCHANT: Photo Shop\nTOTAL: 5.00\nCATEGORY: office supplies",
      stored: { buffer: TINY_PNG, mime: "image/png" },
    }),
    renderReceiptImage,
    renderEmailImage: async () => TINY_PNG,
    renderTextEmail: async () => TINY_PNG,
    sendReply: async (input) => {
      sent.push({
        subject: input.subject,
        html: input.html,
        to: input.to,
        ...(input.attachments?.length
          ? { attachments: input.attachments }
          : {}),
      });
    },
  };
  return { ...deps, sent, downloads };
}

/** The expense id from a created/partial result (asserts the status). */
function expenseIdOf(result: ProcessResult): string {
  if (result.status === "created" || result.status === "partial") {
    return result.expenseId;
  }
  throw new Error(`Expected created/partial, got ${result.status}`);
}

/** Narrow an expense to a receipt (throws otherwise). */
function asReceipt(expense: Expense | undefined): ReceiptExpense {
  if (!expense || expense.type !== "receipt") {
    throw new Error("Expected a receipt expense");
  }
  return expense;
}

const usedEmailIds: string[] = [];
const usedExpenseIds: string[] = [];
const usedSenders: { accountId: string; address: string }[] = [];

/**
 * Allow a sender for an account and remember it for cleanup. By default the
 * sender is VERIFIED (a verification row exists) so the pipeline accepts it;
 * pass `verified: false` for added-but-unverified senders.
 */
async function allowSender(
  accountId: string,
  address: string,
  createdAt = new Date().toISOString(),
  verified = true,
): Promise<void> {
  const normalized = address.toLowerCase();
  await testPrisma.inboundSender.createMany({
    data: [{ accountId, address: normalized, createdAt }],
    skipDuplicates: true,
  });
  if (verified) {
    await testPrisma.inboundSenderVerification.createMany({
      data: [{ address: normalized, accountId, verifiedAt: createdAt }],
      skipDuplicates: true,
    });
  }
  usedSenders.push({ accountId, address: normalized });
}

beforeEach(async () => {
  await allowSender(TEST_ACCOUNT_ID, SENDER);
});

afterEach(async () => {
  for (const id of usedExpenseIds) {
    await deleteExpense(id, TEST_ACCOUNT_ID).catch(() => {});
    await deleteExpense(id, OTHER_ACCOUNT_ID).catch(() => {});
  }
  usedExpenseIds.length = 0;
  if (usedEmailIds.length > 0) {
    await testPrisma.inboundEmail
      .deleteMany({ where: { emailId: { in: usedEmailIds } } })
      .catch(() => {});
    usedEmailIds.length = 0;
  }
  for (const s of usedSenders) {
    await testPrisma.inboundSender
      .deleteMany({ where: { accountId: s.accountId, address: s.address } })
      .catch(() => {});
    await testPrisma.inboundSenderVerification
      .deleteMany({ where: { accountId: s.accountId, address: s.address } })
      .catch(() => {});
  }
  usedSenders.length = 0;
});

describe("Date extraction", () => {
  it("parses RFC 2822 and human dates", () => {
    expect(parseDateString("Tue, 10 Feb 2026 09:15:22 -0800")).toBe(
      "2026-02-10",
    );
    expect(parseDateString("June 5, 2026 10:12:33 PDT")).toBe("2026-06-05");
    expect(parseDateString("garbage")).toBeNull();
  });

  it("parses Gmail-style human dates with 'at'", () => {
    expect(parseDateString("Tue, Jun 2, 2026 at 3:14 PM")).toBe("2026-06-02");
  });

  it("rejects future dates", () => {
    expect(parseDateString("Jan 1 2100")).toBeNull();
  });

  it("extracts the forwarded message date (Apple/Gmail style)", () => {
    const text = [
      "Begin forwarded message:",
      "",
      "From: Amazon <no-reply@amazon.com>",
      "Date: June 5, 2026 10:12:33 PDT",
      "Subject: Your receipt",
      "",
      "Order total $42.50",
    ].join("\n");
    expect(extractDateFromForwardedText(text)).toBe("2026-06-05");
  });

  it("extracts the forwarded message date (Gmail quote style)", () => {
    const text = [
      "---------- Forwarded message ----------",
      "From: X <x@y.com>",
      "Date: Mon, 2 Mar 2026 08:00:00 +0000",
      "Subject: hi",
    ].join("\n");
    expect(extractDateFromForwardedText(text)).toBe("2026-03-02");
  });

  it("extracts the forwarded date when Gmail uses 'at' (the common case)", () => {
    const text = [
      "---------- Forwarded message ----------",
      "From: Amazon <no-reply@amazon.com>",
      "Date: Tue, Jun 2, 2026 at 3:14 PM",
      "Subject: Your order receipt",
      "To: me@gmail.com",
      "",
      "Order total $42.50",
    ].join("\n");
    expect(extractDateFromForwardedText(text)).toBe("2026-06-02");
  });

  it("extracts the forwarded date from Outlook-style forwards (no marker, Sent:)", () => {
    const text = [
      "From: Amazon <no-reply@amazon.com>",
      "Sent: Tuesday, June 2, 2026 3:14 PM",
      "To: me@outlook.com",
      "Subject: Your order receipt",
      "",
      "Order total $42.50",
    ].join("\n");
    expect(extractDateFromForwardedText(text)).toBe("2026-06-02");
  });

  it("extracts the forwarded date from Outlook forwards with a Date: header", () => {
    const text = [
      "From: X <x@y.com>",
      "Sent: Jun 2, 2026 3:14 PM",
      "To: me@outlook.com",
      "Cc: other@example.com",
      "Subject: Your order receipt",
      "Date: Tue, 2 Jun 2026 22:14:22 +0000",
    ].join("\n");
    expect(extractDateFromForwardedText(text)).toBe("2026-06-02");
  });

  it("extracts the forwarded date from Yahoo-style forwards (Sent:)", () => {
    const text = [
      "----- Forwarded Message -----",
      "From: Amazon <no-reply@amazon.com>",
      "To: me@yahoo.com",
      "Sent: Tuesday, June 2, 2026 3:14 PM",
      "Subject: Your order receipt",
    ].join("\n");
    expect(extractDateFromForwardedText(text)).toBe("2026-06-02");
  });

  it("extracts the date from an .eml attachment", () => {
    const eml =
      "Date: Tue, 10 Feb 2026 09:15:22 -0800\nFrom: a@b.com\nSubject: x\n\nbody";
    expect(extractDateFromEml(eml)).toBe("2026-02-10");
  });

  it("prefers the forwarded date over the received header date", () => {
    const email = receivedEmail();
    expect(extractExpenseDate(email)).toBe("2026-06-05");
  });

  it("falls back to the received email header date", () => {
    const email = receivedEmail({
      text: "plain receipt without forward block",
    });
    expect(extractExpenseDate(email)).toBe("2026-06-20");
  });

  it("falls back to the arrival time when nothing else parses", () => {
    const email = receivedEmail({ text: null, html: null, headers: {} });
    expect(extractExpenseDate(email)).toBe("2026-06-20");
  });
});

describe("Email address extraction", () => {
  it("strips display names and lowercases", () => {
    expect(extractEmailAddress("Forwarder <Foo@Bar.com>")).toBe("foo@bar.com");
    expect(extractEmailAddress("plain@address.com")).toBe("plain@address.com");
    expect(extractEmailAddress("")).toBe("");
  });
});

describe("Attachment selection", () => {
  it("prefers a PDF over a small inline logo", () => {
    const atts = [
      attachment({
        id: "logo",
        filename: "logo.png",
        size: 4000,
        content_type: "image/png",
        content_disposition: "inline",
      }),
      attachment({ id: "pdf", filename: "invoice.pdf" }),
    ];
    const pick = pickReceiptAttachment(atts, "");
    expect(pick?.index).toBe(1);
    expect(pick?.ambiguous).toBe(false);
  });

  it("boosts an inline image referenced by the HTML (embedded receipt picture)", () => {
    const html = '<img src="cid:img001">';
    const atts = [
      attachment({
        id: "inline-receipt",
        filename: "image001.png",
        size: 300_000,
        content_type: "image/png",
        content_disposition: "inline",
        content_id: "img001",
      }),
      attachment({
        id: "other",
        filename: "banner.gif",
        size: 25_000,
        content_type: "image/gif",
        content_disposition: "inline",
      }),
    ];
    const pick = pickReceiptAttachment(atts, html);
    expect(pick?.index).toBe(0);
  });

  it("returns null when nothing looks like a receipt", () => {
    const atts = [
      attachment({
        id: "logo",
        filename: "logo.png",
        size: 3000,
        content_type: "image/png",
        content_disposition: "inline",
      }),
      attachment({
        id: "sig",
        filename: "signature.png",
        size: 5000,
        content_type: "image/png",
        content_disposition: "inline",
      }),
    ];
    expect(pickReceiptAttachment(atts, "")).toBeNull();
  });

  it("ignores non-receipt attachments (eml, vcf)", () => {
    const atts = [
      attachment({
        id: "eml",
        filename: "original.eml",
        size: 1000,
        content_type: "message/rfc822",
      }),
      attachment({
        id: "vcf",
        filename: "contact.vcf",
        size: 500,
        content_type: "text/vcard",
      }),
    ];
    expect(pickReceiptAttachment(atts, "")).toBeNull();
  });

  it("flags ambiguity when two strong candidates are close", () => {
    const atts = [
      attachment({ id: "a", filename: "receipt.pdf", size: 10_000 }),
      attachment({ id: "b", filename: "statement.pdf", size: 12_000 }),
    ];
    const pick = pickReceiptAttachment(atts, "");
    expect(pick).not.toBeNull();
    expect(pick?.ambiguous).toBe(true);
  });

  it("scores receipt-named files higher and logo-named files lower", () => {
    expect(
      scoreAttachment(attachment({ filename: "receipt.pdf" }), ""),
    ).toBeGreaterThan(
      scoreAttachment(
        attachment({ filename: "logo.png", content_type: "image/png" }),
        "",
      ),
    );
  });
});

describe("Category matching", () => {
  const cats = ["Office Supplies", "Travel", "Meals"];

  it("matches case-insensitively", () => {
    expect(matchCategory("office supplies", cats)).toBe("Office Supplies");
  });

  it("returns empty when nothing matches", () => {
    expect(matchCategory("Unrelated", cats)).toBe("");
    expect(matchCategory("", cats)).toBe("");
  });
});

describe("HTML to text", () => {
  it("converts block elements to lines", () => {
    expect(htmlToText("<p>Hello</p><p>World</p>")).toBe("Hello\nWorld");
  });

  it("keeps table cell layout", () => {
    const html =
      "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>";
    const text = htmlToText(html);
    expect(text).toContain("A  B");
    expect(text).toContain("C  D");
  });

  it("drops scripts and styles", () => {
    const html = "<script>evil()</script><style>p{color:red}</style><p>Hi</p>";
    expect(htmlToText(html)).not.toContain("evil");
    expect(htmlToText(html)).toContain("Hi");
  });
});

describe("Receipt rendering", () => {
  it("builds an SVG with escaped text", () => {
    const svg = buildReceiptSvg("Total: $42.50 <tax>", {
      subject: "Receipt & more",
    });
    expect(svg).toContain("Receipt &amp; more");
    expect(svg).toContain("$42.50 &lt;tax&gt;");
    expect(svg).toContain("<svg");
  });

  it("renders a PNG with the expected signature", async () => {
    const png = await renderReceiptImage("MERCHANT: Amazon\nTOTAL: 42.50");
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png.length).toBeGreaterThan(100);
  });

  it("renders visible ink, not a blank sheet", async () => {
    const png = await renderReceiptImage(
      "MERCHANT: Amazon\nTOTAL: 42.50\nDate: 2026-06-05",
      { subject: "Fwd: Your receipt" },
    );
    const stats = await sharp(png).stats();
    const minInk = Math.min(...stats.channels.slice(0, 3).map((c) => c.min));
    expect(minInk).toBeLessThan(250); // at least one non-white pixel
  });
});

describe("DeepSeek JSON parsing", () => {
  it("strips markdown fences", () => {
    expect(parseJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("extracts JSON from prose", () => {
    expect(parseJsonObject('Here: {"b": 2} thanks')).toEqual({ b: 2 });
  });
});

describe("Remote image fetch guards", () => {
  it("blocks loopback, private, link-local, and reserved hosts", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
    expect(isPrivateHost("0.0.0.0")).toBe(true);
    expect(isPrivateHost("255.255.255.255")).toBe(true);
  });

  it("allows public hosts and public IPs", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("stripe-images.stripecdn.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("93.184.216.34")).toBe(false);
  });

  it("rejects invalid, non-http(s), and private URLs without a network call", async () => {
    expect(await fetchRemoteImageImpl("not a url")).toBeNull();
    expect(await fetchRemoteImageImpl("ftp://example.com/a.png")).toBeNull();
    expect(await fetchRemoteImageImpl("file:///etc/passwd")).toBeNull();
    expect(await fetchRemoteImageImpl("data:image/png;base64,x")).toBeNull();
    expect(await fetchRemoteImageImpl("http://127.0.0.1/a.png")).toBeNull();
    expect(
      await fetchRemoteImageImpl("http://localhost:8080/a.png"),
    ).toBeNull();
    expect(
      await fetchRemoteImageImpl("http://169.254.169.254/latest/meta-data/"),
    ).toBeNull();
  });
});

describe("processInboundEvent (forward header + remote images)", () => {
  it("strips the forward-quote header before rendering the email body", async () => {
    const deps = fakeDeps();
    const html = [
      "<html><body>",
      "<div>----- Original message -----</div>",
      "<div>From: zai &lt;receipts@stripe.com&gt;</div>",
      "<div>Date: Thursday, July 30, 2026 5:15 PM</div>",
      "<div><br></div>",
      "<div>MERCHANT: zai</div>",
      "<div>TOTAL: 10.00</div>",
      "<div>CATEGORY: office supplies</div>",
      "</body></html>",
    ].join("\n");
    const rendered: string[] = [];
    deps.fetchReceivedEmail = async () => receivedEmail({ html });
    deps.renderEmailImage = async (h) => {
      rendered.push(h);
      return TINY_PNG;
    };
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "created" });
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).not.toContain("Original message");
    expect(rendered[0]).not.toContain("From: zai");
    expect(rendered[0]).toContain("MERCHANT: zai");
  });

  it("passes a remote-image fetcher into the browser render", async () => {
    const deps = fakeDeps();
    let fetcher: unknown;
    deps.fetchReceivedEmail = async () =>
      receivedEmail({ html: "<html><body>Receipt</body></html>" });
    deps.renderEmailImage = async (_h, opts) => {
      fetcher = opts?.fetchRemoteImage;
      return TINY_PNG;
    };
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "created" });
    expect(typeof fetcher).toBe("function");
  });

  it("strips the forward block from the text used for extraction", async () => {
    const deps = fakeDeps();
    const extracted: (string | undefined)[] = [];
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        text: [
          "----- Original message -----",
          "From: zai <receipts@stripe.com>",
          "Date: Thu, 30 Jul 2026 5:15 PM",
          "Subject: receipt",
          "",
          "MERCHANT: zai",
          "TOTAL: 10.00",
          "CATEGORY: office supplies",
        ].join("\n"),
      });
    deps.extractReceipt = async (input) => {
      extracted.push(input.text);
      return fakeExtract(input.text);
    };
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "created" });
    expect(extracted[0]).toContain("MERCHANT: zai");
    expect(extracted[0]).not.toContain("Original message");
    expect(extracted[0]).not.toContain("From:");
  });
});

describe("processInboundEvent (body receipt)", () => {
  it("creates an expense with the forwarded email date", async () => {
    const deps = fakeDeps();
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");

    expect(result).toMatchObject({ status: "created" });
    const expenses = await readExpenses(TEST_ACCOUNT_ID);
    const created = asReceipt(
      expenses.find((e) => e.id === expenseIdOf(result)),
    );
    expect(created.type).toBe("receipt");
    expect(created.merchant).toBe("Amazon");
    expect(created.amount).toBe("42.50");
    expect(created.date).toBe("2026-06-05"); // forwarded message date, not header
    expect(created.category).toBe("Office Supplies"); // matched existing category
    expect(created.imageFile).not.toBe("");
    expect(created.imageMime).toBe("image/jpeg"); // body render stored as JPEG
    usedExpenseIds.push(expenseIdOf(result));
    // Successful imports send a confirmation email.
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.subject).toBe(
      "👍 Receipt accepted: $42.50 \u2014 Office Supplies",
    );
    // … attaching the stored receipt image (attachment only — never inline
    // in the body).
    const confirmation = deps.sent[0]!;
    expect(confirmation.attachments).toHaveLength(1);
    const att = confirmation.attachments![0]!;
    expect(att.content.length).toBeGreaterThan(100);
    expect(confirmation.html).not.toContain("cid:");
    expect(confirmation.html).not.toContain("<img");
  });

  it("shows the extracted description as a field and saves it on the expense", async () => {
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        text: "MERCHANT: Amazon\nTOTAL: 42.50\nCATEGORY: office supplies\nDESCRIPTION: Printer paper",
      });
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));

    expect(result).toMatchObject({ status: "created" });
    const created = asReceipt(
      (await readExpenses(TEST_ACCOUNT_ID)).find(
        (e) => e.id === expenseIdOf(result),
      ),
    );
    expect(created.description).toBe("Printer paper");
    expect(deps.sent[0]!.html).toContain("Description");
    expect(deps.sent[0]!.html).toContain("Printer paper");
  });

  it("shows report before/after aggregates in the confirmation email", async () => {
    // Seed a report with two known expenses so the before state is exact.
    const reportName = "Inbound Report";
    await testPrisma.report.create({
      data: { name: reportName, accountId: TEST_ACCOUNT_ID },
    });
    const now = new Date().toISOString();
    await testPrisma.expense.createMany({
      data: [
        {
          id: "seed-a",
          accountId: TEST_ACCOUNT_ID,
          type: "receipt",
          date: "2026-01-01",
          report: reportName,
          category: "Testing",
          description: "",
          amount: "10.00",
          merchant: "A",
          imageFile: "",
          imageMime: "",
          originalName: "",
          distanceMiles: null,
          locations: [],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "seed-b",
          accountId: TEST_ACCOUNT_ID,
          type: "receipt",
          date: "2026-01-02",
          report: reportName,
          category: "Testing",
          description: "",
          amount: "20.00",
          merchant: "B",
          imageFile: "",
          imageMime: "",
          originalName: "",
          distanceMiles: null,
          locations: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        text: "MERCHANT: Amazon\nTOTAL: 5.00\nCATEGORY: office supplies\nREPORT: Inbound Report",
      });
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));

    expect(result).toMatchObject({ status: "created" });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.subject).toBe(
      "👍 Receipt accepted: $5.00 \u2014 Office Supplies \u2014 Inbound Report",
    );
    const html = deps.sent[0]!.html;
    expect(html).toContain(
      "FYI: Inbound Report increased from 2 expenses / $30.00 to 3 expenses / $35.00",
    );

    // Cleanup seeded rows.
    await testPrisma.expense.deleteMany({
      where: { id: { in: ["seed-a", "seed-b"] } },
    });
    await testPrisma.report.deleteMany({
      where: { name: reportName, accountId: TEST_ACCOUNT_ID },
    });
  });

  it("says decreased when the report total drops", async () => {
    const reportName = "Refund Report";
    await testPrisma.report.create({
      data: { name: reportName, accountId: TEST_ACCOUNT_ID },
    });
    const now = new Date().toISOString();
    await testPrisma.expense.createMany({
      data: [
        {
          id: "seed-c",
          accountId: TEST_ACCOUNT_ID,
          type: "receipt",
          date: "2026-01-01",
          report: reportName,
          category: "Testing",
          description: "",
          amount: "30.00",
          merchant: "C",
          imageFile: "",
          imageMime: "",
          originalName: "",
          distanceMiles: null,
          locations: [],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "seed-d",
          accountId: TEST_ACCOUNT_ID,
          type: "receipt",
          date: "2026-01-02",
          report: reportName,
          category: "Testing",
          description: "",
          amount: "20.00",
          merchant: "D",
          imageFile: "",
          imageMime: "",
          originalName: "",
          distanceMiles: null,
          locations: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const deps = fakeDeps();
    deps.extractReceipt = async (input) => ({
      ...fakeExtract(input.text),
      amount: "-20.00",
    });
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        text: "MERCHANT: Amazon\nTOTAL: -20.00\nCATEGORY: office supplies\nREPORT: Refund Report",
      });
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));

    expect(result).toMatchObject({ status: "created" });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.html).toContain(
      "FYI: Refund Report decreased from 2 expenses / $50.00 to 3 expenses / $30.00",
    );

    await testPrisma.expense.deleteMany({
      where: { id: { in: ["seed-c", "seed-d"] } },
    });
    await testPrisma.report.deleteMany({
      where: { name: reportName, accountId: TEST_ACCOUNT_ID },
    });
  });

  it("reuses the category a previous expense for the same merchant used", async () => {
    // The model suggests a different category, but a seeded prior expense
    // for "Test Store" is filed under Testing — the merchant's own category
    // wins over the guess.
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        text: "MERCHANT: Test Store\nTOTAL: 7.25\nCATEGORY: office supplies",
      });
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "created" });
    const expenses = await readExpenses(TEST_ACCOUNT_ID);
    const created = asReceipt(
      expenses.find((e) => e.id === expenseIdOf(result)),
    );
    expect(created.merchant).toBe("Test Store");
    expect(created.category).toBe("Testing");
  });

  it("skips the model when the body names a known merchant with a total", async () => {
    // The body names "Test Store" (seeded history: Testing / 2026 Test) and
    // carries a parseable total — the known-merchant skip must produce the
    // expense without consulting the model at all.
    const deps = fakeDeps();
    let modelCalls = 0;
    deps.extractReceipt = async (input) => {
      modelCalls++;
      return fakeExtract(input.text);
    };
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        text: "Thank you for shopping at Test Store\nTOTAL: 7.25",
      });
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "created" });
    const expenses = await readExpenses(TEST_ACCOUNT_ID);
    const created = asReceipt(
      expenses.find((e) => e.id === expenseIdOf(result)),
    );
    expect(created.merchant).toBe("Test Store");
    expect(created.category).toBe("Testing");
    expect(created.report).toBe("2026 Test");
    expect(created.amount).toBe("7.25");
    expect(modelCalls).toBe(0);
  });

  it("renders the HTML body through the browser renderer and resolves cid images", async () => {
    const deps = fakeDeps();
    const html =
      '<html><body><img src="cid:logo1"><h1>Your receipt</h1></body></html>';
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        html,
        text: "MERCHANT: Amazon\nTOTAL: 42.50\nCATEGORY: office supplies",
      });
    deps.listAttachments = async () => [
      attachment({
        id: "att-logo",
        filename: "logo.png",
        content_type: "image/png",
        content_disposition: "inline",
        content_id: "logo1",
      }),
    ];
    const renderedHtml: string[] = [];
    let textRenderCalls = 0;
    deps.renderEmailImage = async (h, opts) => {
      renderedHtml.push(h);
      await opts?.resolveImage?.("logo1");
      return TINY_PNG;
    };
    deps.renderTextEmail = async () => {
      textRenderCalls += 1;
      return TINY_PNG;
    };
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "created" });
    expect(renderedHtml).toEqual([html]);
    expect(textRenderCalls).toBe(0);
    // The inline image referenced by the HTML was downloaded for the render.
    expect(deps.downloads.map((d) => d.filename)).toContain("logo.png");
  });

  it("falls back to the resvg text sheet when the browser render fails", async () => {
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({ html: "<html><body>Receipt</body></html>" });
    deps.renderEmailImage = async () => {
      throw new Error("chromium boom");
    };
    let textSheetCalls = 0;
    deps.renderReceiptImage = async (text, opts) => {
      textSheetCalls += 1;
      return renderReceiptImage(text, opts);
    };
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "created" });
    expect(textSheetCalls).toBe(1);
    // Successful imports send a confirmation email.
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.subject).toBe(
      "👍 Receipt accepted: $42.50 \u2014 Office Supplies",
    );
  });

  it("renders text-only emails through the plain-text renderer", async () => {
    const deps = fakeDeps();
    let htmlRenderCalls = 0;
    let textRenderCalls = 0;
    let textOptions: RenderTextEmailOptions | undefined;
    deps.renderEmailImage = async () => {
      htmlRenderCalls += 1;
      return TINY_PNG;
    };
    deps.renderTextEmail = async (_text, opts) => {
      textRenderCalls += 1;
      textOptions = opts;
      return TINY_PNG;
    };
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "created" });
    expect(htmlRenderCalls).toBe(0);
    expect(textRenderCalls).toBe(1);
    expect(textOptions).toEqual({
      subject: "Fwd: Receipt from Amazon",
      from: `Forwarder <${SENDER}>`,
    });
  });

  it("sends no expense to the other account", async () => {
    const deps = fakeDeps();
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));
    const other = await readExpenses(OTHER_ACCOUNT_ID);
    expect(other.some((e) => e.id === expenseIdOf(result))).toBe(false);
  });

  it("is idempotent for the same email_id", async () => {
    const deps = fakeDeps();
    const first = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(first));
    const before = (await readExpenses(TEST_ACCOUNT_ID)).length;
    const second = await processInboundEvent(eventData(), deps);
    expect(second).toMatchObject({ status: "duplicate" });
    expect((await readExpenses(TEST_ACCOUNT_ID)).length).toBe(before);
  });

  it("creates a partial expense and replies when merchant is missing", async () => {
    const deps = fakeDeps();
    const email = receivedEmail({
      text: "Begin forwarded message:\n\nFrom: X <x@y.com>\nDate: June 5, 2026\n\nTOTAL: 12.00",
    });
    deps.fetchReceivedEmail = async () => email;
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "partial" });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.subject).toContain("needs attention");
    expect(deps.sent[0]!.html).toContain("merchant");
    // The partial confirmation still attaches the rendered receipt image
    // (attachment only — never inline in the body).
    const partial = deps.sent[0]!;
    expect(partial.attachments).toHaveLength(1);
    expect(partial.html).not.toContain("cid:");
    expect(partial.html).not.toContain("<img");
  });

  it("replies when the email contains no receipt at all", async () => {
    const deps = fakeDeps();
    const email = receivedEmail({ text: "", html: null });
    deps.fetchReceivedEmail = async () => email;
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    expect(result).toMatchObject({ status: "error" });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.html).toContain("couldn't find a receipt");
  });

  it("does not send a second error reply when the webhook is retried", async () => {
    const deps = fakeDeps();
    const email = receivedEmail({ text: "", html: null });
    deps.fetchReceivedEmail = async () => email;
    const first = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    expect(first).toMatchObject({ status: "error" });
    expect(deps.sent).toHaveLength(1);
    // Resend retries after the route's non-2xx response: the pipeline
    // re-runs and fails again, but the sender must not get a second,
    // duplicate error email.
    const second = await processInboundEvent(eventData(), deps);
    expect(second).toMatchObject({ status: "error" });
    expect(deps.sent).toHaveLength(1);
  });

  it("replies when the content is not a receipt", async () => {
    const deps = fakeDeps();
    const email = receivedEmail({ text: "Hi, what's up?", html: null });
    deps.fetchReceivedEmail = async () => email;
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    expect(result).toMatchObject({ status: "error" });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.html).toContain("doesn't look like a receipt");
  });

  it("replies and does not create an expense when extraction fails", async () => {
    const deps = fakeDeps();
    deps.extractReceipt = async () => {
      throw new Error("mock extraction failure");
    };
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    expect(result).toMatchObject({ status: "error" });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.html).toContain("mock extraction failure");
    const expenses = await readExpenses(TEST_ACCOUNT_ID);
    expect(
      expenses.some((e) => e.type === "receipt" && e.merchant === "Amazon"),
    ).toBe(false);
  });

  it("rejects unknown senders with a reply and no expense", async () => {
    const deps = fakeDeps();
    const result = await processInboundEvent(
      eventData({ from: "Stranger <stranger@evil.com>" }),
      deps,
    );
    expect(result).toMatchObject({ status: "unknown-sender" });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.subject).toContain("sender not recognized");
    const expenses = await readExpenses(TEST_ACCOUNT_ID);
    expect(
      expenses.some((e) => e.type === "receipt" && e.merchant === "Amazon"),
    ).toBe(false);
  });

  it("silently drops a daemon bounce without replying or importing", async () => {
    const deps = fakeDeps();
    const before = (await readExpenses(TEST_ACCOUNT_ID)).length;
    const result = await processInboundEvent(
      eventData({
        from: "Mail Delivery System <MAILER-DAEMON@messagingengine.com>",
        subject: "Undelivered Mail Returned to Sender",
        message_id: "<bounce-1@mailfhigh.stl.internal>",
      }),
      deps,
    );
    expect(result).toMatchObject({ status: "bounce" });
    expect(deps.sent).toHaveLength(0);
    expect((await readExpenses(TEST_ACCOUNT_ID)).length).toBe(before);
  });

  it("names the failed recipient found in the DSN body", async () => {
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        text: [
          "The message could not be delivered to the following address(es):",
          "",
          "  <old-contact@dead-example.com>",
        ].join("\n"),
      });
    const result = await processInboundEvent(
      eventData({
        from: "Mail Delivery System <MAILER-DAEMON@messagingengine.com>",
        subject: "Undelivered Mail Returned to Sender",
      }),
      deps,
    );
    expect(result).toMatchObject({
      status: "bounce",
      failedRecipient: "old-contact@dead-example.com",
    });
    expect(deps.sent).toHaveLength(0);
  });

  it("names the failed recipient from a Final-Recipient field", async () => {
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        text: [
          "Final-Recipient: rfc822; old-contact@dead-example.com",
          "Action: failed",
          "Status: 5.1.1",
        ].join("\n"),
      });
    const result = await processInboundEvent(
      eventData({
        from: "Mail Delivery System <MAILER-DAEMON@messagingengine.com>",
        subject: "Undelivered Mail Returned to Sender",
      }),
      deps,
    );
    expect(result).toMatchObject({
      status: "bounce",
      failedRecipient: "old-contact@dead-example.com",
    });
    expect(deps.sent).toHaveLength(0);
  });

  it("names the failed recipient from the embedded original's To header", async () => {
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        from: "Mail Delivery System <MAILER-DAEMON@messagingengine.com>",
        subject: "Undelivered Mail Returned to Sender",
        text: null,
      });
    deps.listAttachments = async () => [
      attachment({
        id: "att-eml",
        filename: "original.eml",
        content_type: "message/rfc822",
        size: 900,
      }),
    ];
    deps.downloadAttachment = async () =>
      Buffer.from(
        [
          "From: expense@labnotes.org",
          "To: old-contact@dead-example.com",
          "Subject: Receipt not imported",
          "",
          "body",
        ].join("\r\n"),
      );
    const result = await processInboundEvent(
      eventData({
        from: "Mail Delivery System <MAILER-DAEMON@messagingengine.com>",
        subject: "Undelivered Mail Returned to Sender",
      }),
      deps,
    );
    expect(result).toMatchObject({
      status: "bounce",
      failedRecipient: "old-contact@dead-example.com",
    });
    expect(deps.sent).toHaveLength(0);
  });

  it("silently drops a DSN with a clean sender but a bounce subject", async () => {
    const deps = fakeDeps();
    const result = await processInboundEvent(
      eventData({
        from: "Stranger <stranger@evil.com>",
        subject: "Delivery Status Notification (Failure)",
      }),
      deps,
    );
    expect(result).toMatchObject({ status: "bounce" });
    expect(deps.sent).toHaveLength(0);
  });

  it("silently drops an autoresponder (vacation notice)", async () => {
    const deps = fakeDeps();
    const result = await processInboundEvent(
      eventData({ subject: "Re: Out of office: Re: Your receipt" }),
      deps,
    );
    expect(result).toMatchObject({ status: "bounce" });
    expect(deps.sent).toHaveLength(0);
  });

  it("drops a verified sender's email carrying DSN headers (null Return-Path)", async () => {
    await allowSender(TEST_ACCOUNT_ID, SENDER, undefined, true);
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        headers: {
          date: "Sat, 20 Jun 2026 09:00:00 -0700",
          "return-path": "<>",
          "content-type": "multipart/report; report-type=delivery-status",
        },
      });
    const before = (await readExpenses(TEST_ACCOUNT_ID)).length;
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    expect(result).toMatchObject({ status: "bounce" });
    expect(deps.sent).toHaveLength(0);
    expect((await readExpenses(TEST_ACCOUNT_ID)).length).toBe(before);
  });

  it("drops a verified sender's autoresponder (Auto-Submitted header)", async () => {
    await allowSender(TEST_ACCOUNT_ID, SENDER, undefined, true);
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({
        headers: {
          date: "Sat, 20 Jun 2026 09:00:00 -0700",
          "auto-submitted": "auto-replied",
        },
      });
    const before = (await readExpenses(TEST_ACCOUNT_ID)).length;
    const result = await processInboundEvent(eventData(), deps);
    usedEmailIds.push("email-1");
    expect(result).toMatchObject({ status: "bounce" });
    expect(deps.sent).toHaveLength(0);
    expect((await readExpenses(TEST_ACCOUNT_ID)).length).toBe(before);
  });

  it("rejects an added-but-unverified sender with a verify-first reply", async () => {
    await allowSender(TEST_ACCOUNT_ID, "pending@example.com", undefined, false);
    const deps = fakeDeps();
    const result = await processInboundEvent(
      eventData({
        email_id: "email-pending-sender",
        from: "Pending <pending@example.com>",
      }),
      deps,
    );
    expect(result).toMatchObject({ status: "unverified-sender" });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.subject).toContain("not verified");
    expect(deps.sent[0]!.html).toContain("Settings");
    const expenses = await readExpenses(TEST_ACCOUNT_ID);
    expect(
      expenses.some((e) => e.type === "receipt" && e.merchant === "Amazon"),
    ).toBe(false);
  });
});

describe("processInboundEvent (verified sender exclusivity)", () => {
  it("accepts any verified address in the sender list", async () => {
    await allowSender(TEST_ACCOUNT_ID, "home@example.com");
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({ from: "Home <home@example.com>" });
    const result = await processInboundEvent(
      eventData({
        email_id: "email-second-sender",
        from: "Home <home@example.com>",
      }),
      deps,
    );
    usedEmailIds.push("email-second-sender");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "created" });
  });

  it("only the verified account receives, regardless of who added first", async () => {
    // Both accounts added the same address; only Test Account verified it.
    await allowSender(
      OTHER_ACCOUNT_ID,
      "shared@example.com",
      "2026-01-01T00:00:00.000Z",
      false,
    );
    await allowSender(
      TEST_ACCOUNT_ID,
      "shared@example.com",
      "2026-02-01T00:00:00.000Z",
      true,
    );
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({ from: "Shared <shared@example.com>" });

    const result = await processInboundEvent(
      eventData({
        email_id: "email-shared-1",
        from: "Shared <shared@example.com>",
      }),
      deps,
    );
    usedEmailIds.push("email-shared-1");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result.status === "created" || result.status === "partial").toBe(
      true,
    );
    const inTest = await readExpenses(TEST_ACCOUNT_ID);
    expect(inTest.some((e) => e.id === expenseIdOf(result))).toBe(true);
    const inOther = await readExpenses(OTHER_ACCOUNT_ID);
    expect(inOther.some((e) => e.id === expenseIdOf(result))).toBe(false);
  });

  it("falls through to a new verifier after the owner removes the sender", async () => {
    // Other Account verified the shared address and receives for it.
    await allowSender(
      OTHER_ACCOUNT_ID,
      "shared@example.com",
      "2026-01-01T00:00:00.000Z",
      true,
    );
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({ from: "Shared <shared@example.com>" });

    const first = await processInboundEvent(
      eventData({
        email_id: "email-shared-1",
        from: "Shared <shared@example.com>",
      }),
      deps,
    );
    usedEmailIds.push("email-shared-1");
    usedExpenseIds.push(expenseIdOf(first));
    const inOther1 = await readExpenses(OTHER_ACCOUNT_ID);
    expect(
      inOther1.some((e) => e.id === expenseIdOf(first) && e.type === "receipt"),
    ).toBe(true);

    // The owner removes the sender: the address is freed again.
    await testPrisma.inboundSender.deleteMany({
      where: { accountId: OTHER_ACCOUNT_ID, address: "shared@example.com" },
    });
    await testPrisma.inboundSenderVerification.deleteMany({
      where: { accountId: OTHER_ACCOUNT_ID, address: "shared@example.com" },
    });

    // Test Account adds and verifies it, then receives for it.
    await allowSender(
      TEST_ACCOUNT_ID,
      "shared@example.com",
      "2026-03-01T00:00:00.000Z",
      true,
    );
    const second = await processInboundEvent(
      eventData({
        email_id: "email-shared-2",
        from: "Shared <shared@example.com>",
      }),
      deps,
    );
    usedEmailIds.push("email-shared-2");
    usedExpenseIds.push(expenseIdOf(second));
    expect(second).toMatchObject({ status: "created" });
    const inTest2 = await readExpenses(TEST_ACCOUNT_ID);
    expect(
      inTest2.some((e) => e.id === expenseIdOf(second) && e.type === "receipt"),
    ).toBe(true);
    const inOther2 = await readExpenses(OTHER_ACCOUNT_ID);
    expect(inOther2.some((e) => e.id === expenseIdOf(second))).toBe(false);
  });
});

describe("processInboundEvent (attachments)", () => {
  it("creates an expense from a PDF attachment (text layer)", async () => {
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({ text: null, html: null });
    deps.listAttachments = async () => [
      attachment({
        id: "att-pdf",
        filename: "invoice.pdf",
        size: 12_000,
        content_type: "application/pdf",
        content_disposition: "attachment",
      }),
      attachment({
        id: "att-logo",
        filename: "logo.png",
        size: 4000,
        content_type: "image/png",
        content_disposition: "inline",
      }),
    ];
    // The pipeline delegates PDF handling to extractFromImage (which
    // rasterizes the PDF and prefers its text layer); the fake mirrors
    // that: a PDF input yields the text-layer extraction + a PNG to store.
    deps.extractFromImage = async () => ({
      result: fakeExtract(
        "MERCHANT: Amazon\nTOTAL: 9.99\nCATEGORY: office supplies",
      ),
      text: "MERCHANT: Amazon\nTOTAL: 9.99\nCATEGORY: office supplies",
      stored: { buffer: TINY_PNG, mime: "image/png" },
    });
    const result = await processInboundEvent(
      eventData({ email_id: "email-pdf", subject: "Fwd: Invoice" }),
      deps,
    );
    usedEmailIds.push("email-pdf");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "created" });
    const expenses = await readExpenses(TEST_ACCOUNT_ID);
    const created = asReceipt(
      expenses.find((e) => e.id === expenseIdOf(result)),
    );
    expect(created.merchant).toBe("Amazon");
    expect(created.amount).toBe("9.99");
    expect(created.originalName).toBe("invoice.png"); // PDF stored as PNG name
    expect(created.imageMime).toBe("image/jpeg"); // re-encoded JPEG at save
    expect(created.date).toBe("2026-06-20"); // no forward block → header date
    // Logo was downloaded? No — only the chosen attachment is downloaded.
    expect(deps.downloads.map((m) => m.id)).toEqual(["att-pdf"]);
  });

  it("creates an expense from an image attachment via OCR", async () => {
    const deps = fakeDeps();
    deps.fetchReceivedEmail = async () =>
      receivedEmail({ text: null, html: null });
    deps.listAttachments = async () => [
      attachment({
        id: "att-photo",
        filename: "photo.jpg",
        size: 500_000,
        content_type: "image/jpeg",
        content_disposition: "attachment",
      }),
    ];
    const result = await processInboundEvent(
      eventData({ email_id: "email-photo", subject: "Fwd: Receipt photo" }),
      deps,
    );
    usedEmailIds.push("email-photo");
    usedExpenseIds.push(expenseIdOf(result));
    expect(result).toMatchObject({ status: "created" });
    const expenses = await readExpenses(TEST_ACCOUNT_ID);
    const created = asReceipt(
      expenses.find((e) => e.id === expenseIdOf(result)),
    );
    expect(created.merchant).toBe("Photo Shop");
    expect(created.amount).toBe("5.00");
    expect(created.imageFile).not.toBe("");
  });
});
