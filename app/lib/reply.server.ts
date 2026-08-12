import { INBOUND_EMAIL_ADDRESS, RESEND_API_KEY } from "~/lib/env";

/**
 * Send email via the Resend Email API from the Expense mailbox — the same
 * mailbox receipts are forwarded to (INBOUND_EMAIL_ADDRESS), so one env var
 * covers routing and From for every email the app sends: inbound failure
 * replies (sendReplyEmail) and sender-verification emails
 * (sendVerificationEmail in sender-verification.server.ts).
 *
 * If Resend isn't configured the send is skipped (the error is logged) —
 * this must never break the caller.
 */

interface ResendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Original email's message id — threads the reply into the same conversation. */
  inReplyTo?: string;
  /** Idempotency key (use the email_id) so Resend retries never double-send. */
  idempotencyKey?: string;
}

/** The From address for every app email. */
const EXPENSE_FROM = `Expense <${INBOUND_EMAIL_ADDRESS}>`;

/** POST an email via the Resend API. Returns false after logging when it
 * can't be sent — callers must never fail because email did. */
export async function sendResendEmail(
  input: ResendEmailInput,
): Promise<boolean> {
  if (!RESEND_API_KEY || !INBOUND_EMAIL_ADDRESS) {
    console.warn(
      `[email] send skipped (RESEND_API_KEY/INBOUND_EMAIL_ADDRESS unset): ${input.subject}`,
    );
    return false;
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
      from: EXPENSE_FROM,
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
    console.warn(`[email] send failed ${res.status}: ${body.slice(0, 300)}`);
    return false;
  }
  return true;
}

/** Send a reply email back to the person who forwarded a receipt. Used for
 * confirmation replies (success + partial) and failure replies. */
export interface ReplyInput extends ResendEmailInput {}

export async function sendReplyEmail(input: ReplyInput): Promise<void> {
  await sendResendEmail(input);
}
