import { escapeHtml } from "~/lib/escape";
import {
  emailShell,
  paragraph,
  valuePropFooter,
} from "~/lib/email-layout.server";
import { sendResendEmail } from "~/lib/reply.server";
import { appBase } from "~/lib/sender-verification.server";

/**
 * Account-verification emails: sent after signup/join (and on resend) with
 * a single-use link. Clicking it marks the user's email verified
 * (verifyUserEmailAddress in database.ts) — until then the account can't
 * sign in. Sends via Resend from the same verified domain as the
 * receipts-by-email mailbox (INBOUND_EMAIL_ADDRESS); when Resend isn't
 * configured the send is skipped and logged — the user row stays pending
 * and the login page's resend button can retry.
 */

/** The absolute verification URL for an account-verification token. */
function verificationLink(origin: string | undefined, token: string): string {
  return `${appBase(origin)}/verify-email?token=${encodeURIComponent(token)}`;
}

/** Send the account-verification email, returning true when Resend
 * accepted it (false after logging when it can't be sent). */
export async function sendAccountVerificationEmail(input: {
  to: string;
  token: string;
  origin?: string;
  accountName: string;
}): Promise<boolean> {
  const link = verificationLink(input.origin, input.token);
  if (!link.startsWith("http")) {
    console.warn(
      "[account-verification] no public origin (set PUBLIC_URL) — cannot email a verify link for " +
        input.to,
    );
    return false;
  }
  const home = appBase(input.origin);
  const subject = "Verify your email to activate your Expense account";
  const html = emailShell({
    title: "Verify your email",
    body: [
      paragraph(
        `You signed up for <b>${escapeHtml(input.accountName)}</b> on Expense with <b>${escapeHtml(input.to)}</b>. Click below to confirm this address is yours and activate the account:`,
      ),
      `<p style="margin:16px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1f2937;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Verify your email</a></p>`,
      paragraph(
        "You'll be able to sign in once the address is verified. This link expires in 7 days — if it has expired, sign in and use the resend button. If you didn't create this account, you can ignore this email.",
      ),
    ].join("\n"),
    footer: valuePropFooter(home),
  });
  return sendResendEmail({ to: input.to, subject, html });
}
