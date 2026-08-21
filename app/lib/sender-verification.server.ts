import { escapeHtml } from "~/lib/escape";
import { paragraph } from "~/lib/email-layout.server";
import { INBOUND_EMAIL_ADDRESS } from "~/lib/env";
import { sendVerificationEmail as sendVerificationEmailCore } from "~/lib/verification-email.server";

/**
 * Verification emails for receipts-by-email sender addresses.
 *
 * Adding an address only accepts receipts after the mailbox owner clicks a
 * link emailed to that address (see verifyInboundSenderAddress in
 * database.ts — single-use token, 7-day expiry, exclusive claim). This
 * module builds and sends that email over the Resend API, from the same
 * verified domain receipts are forwarded to (INBOUND_EMAIL_ADDRESS).
 *
 * The From address doubles as the receipts mailbox, so one env var covers
 * routing, replies, and verification mail. When Resend isn't configured the
 * send is skipped and logged — the sender row stays pending and the owner
 * can retry from the Email page (this must never break the rest of the app).
 * The shell, CTA button, and send live in verification-email.server.ts,
 * shared with the account-verification email.
 */

/** Send the verification email, returning true when Resend accepted it. */
export async function sendVerificationEmail(input: {
  to: string;
  token: string;
  origin?: string;
  accountName: string;
}): Promise<boolean> {
  return sendVerificationEmailCore({
    to: input.to,
    token: input.token,
    origin: input.origin,
    subject: "Verify your email to receive receipts by email",
    verifyPath: "/receipts-email-verify",
    buttonLabel: `Verify ${input.to}`,
    body: [
      paragraph(
        `Receipts forwarded from <b>${escapeHtml(input.to)}</b> to <b>${escapeHtml(INBOUND_EMAIL_ADDRESS)}</b> will be added to the <b>${escapeHtml(input.accountName)}</b> account on Expense.`,
      ),
      paragraph(
        "Until you verify, receipts from this address are <b>not</b> imported. Click below to confirm this address is yours:",
      ),
    ],
    closingNote:
      "This link expires in 7 days. If you didn't add this address, you can ignore this email — nothing will be imported.",
  });
}
