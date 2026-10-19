import { describe, expect, it } from "vite-plus/test";
import { createMimeInboundCache } from "~/lib/mime-inbound.server";

/**
 * The shape budgets on one inbound message. A receipt is a handful of
 * parts; the library's own defaults (10,000 parts, 10,000 forwarded
 * addresses) let a 15 MB message present thousands of parsed nodes and
 * render thousands of addresses into the text the classifier and the LLM
 * prompt read. The 15 MB byte cap bounds the message, not its shape.
 */

/** A multipart/mixed message with `parts` text parts. */
function multipart(parts: number): Buffer {
  const body = Array.from(
    { length: parts },
    (_, i) => `--sep\r\nContent-Type: text/plain\r\n\r\npart ${i}\r\n`,
  ).join("");
  return Buffer.from(
    `Content-Type: multipart/mixed; boundary="sep"\r\n\r\n${body}--sep--\r\n`,
    "utf8",
  );
}

const adapter = (raw: Buffer) => ({
  rawEmail: async () => ({
    raw,
    receivedAt: "2026-07-15T12:00:00.000Z",
    subject: "Your receipt",
    from: "receipts@example.com",
    to: ["you@example.com"],
    messageId: "<shape-budget@example.com>",
  }),
});

describe("inbound MIME budgets", () => {
  it("refuses a message with more parts than the budget", async () => {
    const cache = createMimeInboundCache();
    await expect(
      cache.parsedEmail("over-budget", "id-1", adapter(multipart(200))),
    ).rejects.toThrow();
  });

  it("parses a receipt-shaped message with a handful of parts", async () => {
    const cache = createMimeInboundCache();
    const entry = await cache.parsedEmail(
      "under-budget",
      "id-2",
      adapter(multipart(3)),
    );
    expect(entry.raw.subject).toBe("Your receipt");
  });
});
