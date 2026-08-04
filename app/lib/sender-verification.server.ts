import { escapeHtml } from "~/lib/escape";
import { INBOUND_EMAIL_ADDRESS, PUBLIC_URL, RESEND_API_KEY } from "~/lib/env";

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

/** Resend POST /emails request body, returning true when it was sent. */
export async function sendVerificationEmail(input: {
  to: string;
  token: string;
  origin?: string;
  accountName: string;
}): Promise<boolean> {
  if (!RESEND_API_KEY || !INBOUND_EMAIL_ADDRESS) {
    console.warn(
      "[sender-verification] email skipped (RESEND_API_KEY/INBOUND_EMAIL_ADDRESS unset) for " +
        input.to,
    );
    return false;
  }
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
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.55;color:#1f2937;max-width:560px">
<h2 style="font-size:18px;margin:0 0 12px">Verify your email</h2>
<p style="margin:8px 0">Receipts forwarded from <b>${escapeHtml(input.to)}</b> to <b>${escapeHtml(INBOUND_EMAIL_ADDRESS)}</b> will be added to the <b>${escapeHtml(input.accountName)}</b> account on Expense.</p>
<p style="margin:8px 0">Until you verify, receipts from this address are <b>not</b> imported. Click below to confirm this address is yours:</p>
<p style="margin:16px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1f2937;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Verify ${escapeHtml(input.to)}</a></p>
<p style="margin:8px 0">This link expires in 7 days. If you didn't add this address, you can ignore this email — nothing will be imported.</p>
<p style="margin-top:20px;border-top:1px solid #e5e7eb;padding-top:12px;color:#6b7280;font-size:12px;line-height:1.5">
  <a href="${escapeHtml(home)}/" style="color:#2563eb;text-decoration:none;font-weight:600">Expense</a> — free expense tracking for tax season. Snap a photo, forward a receipt, or log mileage, and Expense sorts it into IRS Schedule C categories and ready-to-file reports.
</p>
</div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Expense <${INBOUND_EMAIL_ADDRESS}>`,
      to: [input.to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(
      `[sender-verification] send failed ${res.status}: ${body.slice(0, 300)}`,
    );
    return false;
  }
  return true;
}
