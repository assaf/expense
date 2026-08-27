/**
 * Shared fixtures for the connected-mailbox tests (email-review.test.ts,
 * email-connection-process.test.ts): fake mailbox adapter, fake
 * extraction collaborators, and DB cleanup over the real test database.
 * The two suites exercise the same pipeline from different ends (the
 * review scan vs the auto-drain), so the fixtures must behave the same
 * in both.
 */
import type { ExtractionResult } from "~/lib/receipt-ai.server";
import { normalizeAmount } from "~/lib/format";
import type { ConnectionDeps } from "~/lib/email-connection-process.server";
import type { ConnectionEmailSummary } from "~/lib/email-connection-mail.server";
import { encryptSecret } from "~/lib/token-crypto.server";
import { testPrisma, TEST_ACCOUNT_ID } from "./seedTestData";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function connection() {
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

export function summary(
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

export function fakeExtractionDeps(): ConnectionDeps {
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

export type FakeEmail = {
  from: string;
  subject: string;
  body: string;
  /** The email's arrival; defaults to the suite-wide instant. */
  receivedAt?: string;
};

/** A fake mailbox adapter over an in-memory set of raw RFC 822 emails.
 * Honours the `limit`/`descending` query shape so the scan's bounded-batch
 * behaviour is testable, and records every query call. */
export function fakeAdapter(emails: Map<string, FakeEmail>) {
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
        summary(id, e.from, e.subject, e.receivedAt),
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
        // Hardcoded like the original fixtures: the summary carries the
        // per-email arrival; the raw message's is never depended on.
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

/** Delete the mailbox@example.com connection, its process log, and the
 * review/forward rules the fixture flows create. The emailAddress is
 * globally unique, so clear by address, not id. */
export async function cleanupConnection(): Promise<void> {
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
    where: {
      accountId: TEST_ACCOUNT_ID,
      source: { in: ["review", "forward"] },
    },
  });
}

export async function logRow(connectionId: string, emailId: string) {
  return testPrisma.emailProcessLog.findUnique({
    where: { connectionId_emailId: { connectionId, emailId } },
  });
}
