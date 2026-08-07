import { escapeHtml } from "~/lib/escape";
import { paragraph } from "~/lib/email-layout.server";
import { sendVerificationEmail as sendVerificationEmailCore } from "~/lib/verification-email.server";

/**
 * Account-verification emails: sent after signup/join (and on resend) with
 * a single-use link. Clicking it marks the user's email verified
 * (verifyUserEmailAddress in database.ts) — until then the account can't
 * sign in. Sends via Resend from the same verified domain as the
 * receipts-by-email mailbox (INBOUND_EMAIL_ADDRESS); when Resend isn't
 * configured the send is skipped and logged — the user row stays pending
 * and the login page's resend button can retry. The shell, CTA button, and
 * send live in verification-email.server.ts, shared with the
 * sender-verification email.
 */

/** Send the account-verification email, returning true when Resend
 * accepted it (false after logging when it can't be sent). */
export async function sendAccountVerificationEmail(input: {
  to: string;
  token: string;
  origin?: string;
  accountName: string;
}): Promise<boolean> {
  return sendVerificationEmailCore({
    to: input.to,
    token: input.token,
    origin: input.origin,
    subject: "Verify your email to activate your Expense account",
    verifyPath: "/verify-email",
    buttonLabel: "Verify your email",
    body: [
      paragraph(
        `You signed up for <b>${escapeHtml(input.accountName)}</b> on Expense with <b>${escapeHtml(input.to)}</b>. Click below to confirm this address is yours and activate the account:`,
      ),
    ],
    closingNote:
      "You'll be able to sign in once the address is verified. This link expires in 7 days — if it has expired, sign in and use the resend button. If you didn't create this account, you can ignore this email.",
  });
}
