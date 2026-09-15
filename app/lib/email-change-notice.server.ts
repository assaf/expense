import { escapeHtml } from "~/lib/escape";
import {
  SIMPLE_FOOTER,
  emailShell,
  paragraph,
  valuePropFooter,
} from "~/lib/email-layout.server";
import { PUBLIC_URL } from "~/lib/env";
import { sendEmail } from "~/lib/reply.server";

/**
 * The notice that goes to a user's OLD address when their sign-in email
 * changes. It is the security half of that feature: whoever still reads the
 * old mailbox learns that the account signs in under another address now,
 * which address that is, and what to do about it if they didn't ask.
 *
 * Only the old address gets it. The new one is unproven at this point (a typo
 * would mail a stranger), and it gets its own email anyway: the
 * receipts-by-email verification link for the account's new default sender.
 */

/** Where "I didn't do this" goes: the address the app's policy pages already
 * point at for account problems. */
const SUPPORT_EMAIL = "assaf@labnotes.org";

export interface EmailChangeNoticeInput {
  /** The address that just stopped being the sign-in email. */
  to: string;
  /** What it changed to; named in the email so the reader knows. */
  newEmail: string;
  /** Account name, so a reader in several accounts knows which one. */
  accountName: string;
  origin?: string;
}

/** Build the notice HTML; `sendEmailChangeNotice` sends this body. */
function emailChangeNoticeHtml(input: EmailChangeNoticeInput): string {
  const home = (input.origin || PUBLIC_URL || "").replace(/\/$/, "");
  return emailShell({
    title: "Sign-in email changed",
    body: [
      paragraph(
        `The sign-in email for <b>${escapeHtml(input.accountName)}</b> on Expense changed to <b>${escapeHtml(input.newEmail)}</b>. This address is no longer the one the account signs in with.`,
      ),
      paragraph(
        "Nothing else about the account changed: the password is the same, and the expenses, receipt images and reports are where you left them.",
      ),
      paragraph(
        `If you didn't change it, write to <b>${SUPPORT_EMAIL}</b> now so we can get the account back to you.`,
      ),
    ].join("\n"),
    // A home link needs a public origin; without one the notice still goes
    // out (this is the email that reports a takeover) with the plain footer.
    footer: home ? valuePropFooter(home) : SIMPLE_FOOTER,
  });
}

/** Send the old-address notice. Returns true when the transport took it; the
 * send path never throws (failures are logged and Sentry-captured), and a
 * missed notice must not undo a change that already happened. */
export async function sendEmailChangeNotice(
  input: EmailChangeNoticeInput,
): Promise<boolean> {
  return sendEmail({
    to: input.to,
    subject: "Your Expense sign-in email was changed",
    text:
      `The sign-in email for ${input.accountName} on Expense changed to ${input.newEmail}.\n\n` +
      `This address is no longer the one the account signs in with. Nothing else about the account changed: the password is the same, and the expenses, receipt images and reports are where you left them.\n\n` +
      `If you didn't change it, write to ${SUPPORT_EMAIL} now so we can get the account back to you.`,
    html: emailChangeNoticeHtml(input),
  });
}
