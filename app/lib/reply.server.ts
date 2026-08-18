import { sendEmailViaJmap } from "~/lib/fastmail.server";
import type { SendEmailInput } from "~/lib/email-mime.server";
import { FASTMAIL_TOKEN } from "~/lib/env";

/**
 * Send email from the app's mailbox through the FastMail JMAP account from
 * the receipts address (INBOUND_EMAIL_ADDRESS — identity-matched, falling
 * back to the account's default identity). Requires FASTMAIL_TOKEN with
 * send permission; when it's unset the send is skipped with a warning (the
 * Resend outbound fallback was removed — the Resend API key now serves the
 * inbound webhook only). Never breaks the caller — failures are logged and
 * Sentry-captured inside the FastMail path, and return false.
 */

/** The send input — same shape the FastMail path consumes (the Resend-only
 * idempotency key died with the Resend fallback). */
export type SendEmailOptions = SendEmailInput;

/** Send an app email through FastMail JMAP. */
export async function sendEmail(input: SendEmailOptions): Promise<boolean> {
  if (!FASTMAIL_TOKEN) {
    console.warn(
      `[email] send skipped (FASTMAIL_TOKEN unset): ${input.subject}`,
    );
    return false;
  }
  const ok = await sendEmailViaJmap(input);
  if (ok) {
    console.info("[email] sent via FastMail", {
      to: input.to,
      subject: input.subject,
    });
  }
  return ok;
}
