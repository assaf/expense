import { escapeHtml } from "~/lib/escape";
import {
  emailShell,
  paragraph,
  valuePropFooter,
} from "~/lib/email-layout.server";
import { INBOUND_EMAIL_ADDRESS, PUBLIC_URL } from "~/lib/env";
import { sendResendEmail } from "~/lib/reply.server";

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
 * can retry from Settings (this must never break the rest of the app).
 */

/**
 * The absolute verification URL for a token. The origin is passed from the
 * request that triggered the email (login / Settings); PUBLIC_URL overrides
 * it for proxy-terminated TLS setups, matching the OAuth metadata behavior.
 */
function verificationLink(origin: string | undefined, token: string): string {
  return `${appBase(origin)}/receipts-email-verify?token=${encodeURIComponent(token)}`;
}

/** The app's public origin (home page base), for links inside the email. */
function appBase(origin: string | undefined): string {
  return (origin || PUBLIC_URL || "").replace(/\/$/, "");
}

/** Send the verification email, returning true when Resend accepted it. */
export async function sendVerificationEmail(input: {
  to: string;
  token: string;
  origin?: string;
  accountName: string;
}): Promise<boolean> {
  const link = verificationLink(input.origin, input.token);
  if (!link.startsWith("http")) {
    console.warn(
      "[sender-verification] no public origin (set PUBLIC_URL) — cannot email a verify link for " +
        input.to,
    );
    return false;
  }
  const home = appBase(input.origin);
  const subject = "Verify your email to receive receipts by email";
  const html = emailShell({
    title: "Verify your email",
    body: [
      paragraph(
        `Receipts forwarded from <b>${escapeHtml(input.to)}</b> to <b>${escapeHtml(INBOUND_EMAIL_ADDRESS)}</b> will be added to the <b>${escapeHtml(input.accountName)}</b> account on Expense.`,
      ),
      paragraph(
        "Until you verify, receipts from this address are <b>not</b> imported. Click below to confirm this address is yours:",
      ),
      `<p style="margin:16px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1f2937;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Verify ${escapeHtml(input.to)}</a></p>`,
      paragraph(
        "This link expires in 7 days. If you didn't add this address, you can ignore this email — nothing will be imported.",
      ),
    ].join("\n"),
    footer: valuePropFooter(home),
  });
  return sendResendEmail({ to: input.to, subject, html });
}
