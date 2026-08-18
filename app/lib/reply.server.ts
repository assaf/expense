import { sendEmailViaJmap } from "~/lib/fastmail.server";
import {
  FASTMAIL_FROM,
  FASTMAIL_TOKEN,
  INBOUND_EMAIL_ADDRESS,
  RESEND_API_KEY,
} from "~/lib/env";

/**
 * Send email from the app's mailbox. When FastMail is configured
 * (FASTMAIL_TOKEN), messages go out through the FastMail JMAP account from
 * the FASTMAIL_FROM address (or the account's default identity); otherwise
 * they go through the Resend API from INBOUND_EMAIL_ADDRESS. Both paths
 * never break the caller — failures are logged and return false.
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
  /** File attachments (e.g. the receipt image). `content` is base64. */
  attachments?: { content: string; filename: string }[];
}

/** The address the app currently sends FROM (FastMail identity when
 * configured, else the Resend inbound address). The inbound pipeline uses
 * this to recognize its own replies looping back (self-reply guard). */
export function outboundFromAddress(): string {
  return FASTMAIL_TOKEN && FASTMAIL_FROM
    ? FASTMAIL_FROM
    : INBOUND_EMAIL_ADDRESS;
}

/** The From address for Resend-sent email (the fallback transport). */
const EXPENSE_FROM = `Expense <${INBOUND_EMAIL_ADDRESS}>`;

/** POST an email via the Resend API. Returns false after logging when it
 * can't be sent — callers must never fail because email did. */
async function sendResendEmail(input: ResendEmailInput): Promise<boolean> {
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
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Include the request shape on failure so a Resend validation error can
    // be traced to the exact field (the to/from/inReplyTo/attachment values
    // come straight from the incoming email). Content is logged as sizes
    // only.
    console.warn(`[email] send failed ${res.status}: ${body.slice(0, 300)}`, {
      to: input.to,
      subject: input.subject,
      inReplyTo: input.inReplyTo,
      htmlBytes: input.html.length,
      textBytes: input.text?.length ?? 0,
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        contentBytes: a.content.length,
      })),
    });
    return false;
  }
  return true;
}

/** Send a reply email back to the person who forwarded a receipt. Used for
 * confirmation replies (success + partial) and failure replies. */
export interface ReplyInput extends ResendEmailInput {}

/**
 * Send an app email through the configured transport: FastMail JMAP when
 * the token is set (with send permission), otherwise the Resend API.
 */
export async function sendEmail(input: ResendEmailInput): Promise<boolean> {
  if (FASTMAIL_TOKEN) {
    return sendEmailViaJmap(input);
  }
  return sendResendEmail(input);
}

export async function sendReplyEmail(input: ReplyInput): Promise<void> {
  await sendEmail(input);
}
