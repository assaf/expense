import { describe, expect, it, vi } from "vitest";
import {
  processInboundEvent,
  type InboundDeps,
  type EmailReceivedData,
} from "~/lib/inbound-email.server";

/**
 * Unknown-sender handling: mail whose From address has no verified or
 * pending sender row must be dropped WITHOUT a reply. The From header is
 * attacker-controlled at SMTP time, so replying would let anyone use the
 * app's mailbox as an unauthenticated mail amplifier against arbitrary
 * addresses (regression: the old code emailed "sender not recognized" to
 * whatever address the attacker put in From).
 */

const data: EmailReceivedData = {
  email_id: "email-unknown-1",
  created_at: "2026-06-01T00:00:00Z",
  from: "attacker@example.net",
  to: ["receipts@expense.test"],
  bcc: [],
  cc: [],
  received_for: ["receipts@expense.test"],
  message_id: "<a1@example.net>",
  subject: "Receipt from store",
  headers: {},
  attachments: [],
};

describe("processInboundEvent unknown sender", () => {
  it("drops the mail and never sends a reply", async () => {
    const sendReply = vi.fn(async () => {});
    const deps = { sendReply } as unknown as InboundDeps;

    const result = await processInboundEvent(data, deps);

    expect(result).toEqual({ status: "unknown-sender" });
    expect(sendReply).not.toHaveBeenCalled();
  });
});
