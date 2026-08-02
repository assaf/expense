import { INBOUND_EMAIL_ADDRESS, RESEND_API_KEY } from "~/lib/env";

/**
 * Send a reply email back to the person who forwarded a receipt (via the
 * Resend Email API). Only used for failures and partial results — successful
 * imports land in the app without an email.
 *
 * The From address is derived from INBOUND_EMAIL_ADDRESS (same verified
 * domain the receipts are forwarded to), so one env var covers both routing
 * and replies. If it isn't configured the reply is skipped (the error is
 * logged); this must never break webhook processing.
 */

export interface ReplyInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Original email's message id — threads the reply into the same conversation. */
  inReplyTo?: string;
  /** Idempotency key (use the email_id) so Resend retries never double-send. */
  idempotencyKey?: string;
}

export async function sendReplyEmail(input: ReplyInput): Promise<void> {
  // Replies come from the same mailbox receipts are forwarded to.
  const from = `Expense <${INBOUND_EMAIL_ADDRESS}>`;
  if (!RESEND_API_KEY || !INBOUND_EMAIL_ADDRESS) {
    console.warn(
      `[inbound] reply skipped (RESEND_API_KEY/INBOUND_EMAIL_ADDRESS unset): ${input.subject}`,
    );
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
      ...(input.idempotencyKey
        ? { "Idempotency-Key": `inbound-reply-${input.idempotencyKey}` }
        : {}),
    },
    body: JSON.stringify({
      from: from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
      ...(input.inReplyTo
        ? {
            headers: {
              "In-Reply-To": input.inReplyTo,
              References: input.inReplyTo,
            },
          }
        : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(
      `[inbound] reply send failed ${res.status}: ${body.slice(0, 300)}`,
    );
  }
}
