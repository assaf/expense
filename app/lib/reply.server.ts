import { sendEmailViaJmap } from "~/lib/fastmail.server";
import type { SendEmailInput } from "~/lib/email-mime.server";
import { captureWarning } from "~/lib/errors.server";
import {
  INBOUND_EMAIL_ADDRESS,
  FASTMAIL_TOKEN,
  RESEND_API_KEY,
} from "~/lib/env";

/**
 * Send email from the app's mailbox. When FastMail is configured
 * (FASTMAIL_TOKEN), messages go out through the FastMail JMAP account from
 * the receipts address (INBOUND_EMAIL_ADDRESS — identity-matched, falling
 * back to the account's default identity); otherwise they go through the
 * Resend API from INBOUND_EMAIL_ADDRESS. Both paths never break the caller
 * — failures are logged and return false.
 */

/** The dispatch input: `SendEmailInput` plus the Resend-only idempotency
 * key (the email_id) so Resend retries never double-send. The FastMail path
 * ignores the extra field. */
export interface SendEmailOptions extends SendEmailInput {
  idempotencyKey?: string;
}

/** The From address for Resend-sent email (the fallback transport). */
const EXPENSE_FROM = `Expense <${INBOUND_EMAIL_ADDRESS}>`;

/** POST an email via the Resend API. Returns false after logging when it
 * can't be sent — callers must never fail because email did. */
async function sendResendEmail(input: SendEmailOptions): Promise<boolean> {
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
    // only. Also captured in Sentry (when initialized) so a silent reply
    // failure doesn't go unnoticed.
    captureWarning(
      `[email] send failed via Resend ${res.status}: ${body.slice(0, 300)}`,
      {
        to: input.to,
        subject: input.subject,
        inReplyTo: input.inReplyTo,
        htmlBytes: input.html.length,
        textBytes: input.text?.length ?? 0,
        attachments: input.attachments?.map((a) => ({
          filename: a.filename,
          contentBytes: a.content.length,
        })),
      },
    );
    return false;
  }
  return true;
}

/** Send an app email through the configured transport: FastMail JMAP when
 * the token is set (with send permission), otherwise the Resend API. */
export async function sendEmail(input: SendEmailOptions): Promise<boolean> {
  if (FASTMAIL_TOKEN) {
    const ok = await sendEmailViaJmap(input);
    if (ok) {
      console.info("[email] sent via FastMail", {
        to: input.to,
        subject: input.subject,
      });
    }
    return ok;
  }
  const ok = await sendResendEmail(input);
  if (ok) {
    console.info("[email] sent via Resend", {
      to: input.to,
      subject: input.subject,
    });
  }
  return ok;
}
