import { sendEmailViaJmap } from "~/lib/fastmail.server";
import type { SendEmailInput } from "~/lib/email-mime.server";
import { FASTMAIL_TOKEN } from "~/lib/env";

/**
 * Send email from the app's mailbox through the Fastmail JMAP account from
 * the receipts address (INBOUND_EMAIL_ADDRESS, identity-matched, falling
 * back to the account's default identity). Requires FASTMAIL_TOKEN with
 * send permission; when it's unset the send is skipped with a warning.
 * Never breaks the caller: failures are logged and Sentry-captured inside
 * the Fastmail path, and return false.
 */

/** The send input. */
export type SendEmailOptions = SendEmailInput;

/** Send an app email through Fastmail JMAP. */
export async function sendEmail(input: SendEmailOptions): Promise<boolean> {
  if (!FASTMAIL_TOKEN) {
    console.warn(
      `[email] send skipped (FASTMAIL_TOKEN unset): ${input.subject}`,
    );
    return false;
  }
  const ok = await sendEmailViaJmap(input);
  if (ok) {
    console.info("[email] sent via Fastmail", {
      to: input.to,
      subject: input.subject,
    });
  }
  return ok;
}
