import { escapeHtml } from "~/lib/escape";
import {
  emailShell,
  paragraph,
  valuePropFooter,
} from "~/lib/email-layout.server";
import { PUBLIC_URL } from "~/lib/env";
import { sendEmail } from "~/lib/reply.server";

/**
 * Shared builder for the app's two verification emails: the account
 * signup/join email (account-verification.server.ts) and the
 * receipts-by-email sender email (sender-verification.server.ts). Both
 * email a single-use token link, render the same shell + CTA button +
 * footer, and skip (with a warning) when no public origin can be
 * determined. The callers supply the subject, verify path, button label,
 * and copy; the send must never break the caller.
 */

/** The app's public origin (home page base), for links inside the email. */
function appBase(origin: string | undefined): string {
  return (origin || PUBLIC_URL || "").replace(/\/$/, "");
}

/** The absolute verification URL for a token at the given path. */
function verificationLink(
  origin: string | undefined,
  path: string,
  token: string,
): string {
  return `${appBase(origin)}${path}?token=${encodeURIComponent(token)}`;
}

/** The CTA button markup shared by every verification email. */
function verifyButton(link: string, label: string): string {
  return `<p style="margin:16px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1f2937;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(label)}</a></p>`;
}

/**
 * Send a verification email for a single-use token link: the intro
 * paragraphs, the CTA button, and a closing note inside the shared email
 * shell. Returns true when the transport accepted it, false after logging
 * when it can't be sent or no public origin is set (PUBLIC_URL), because
 * callers must never fail because email did.
 */
export interface VerificationEmailInput {
  to: string;
  token: string;
  origin?: string;
  subject: string;
  /** Absolute path the token verifies at, e.g. "/verify-email". */
  verifyPath: string;
  /** CTA button label, e.g. "Verify your email". */
  buttonLabel: string;
  /** Paragraphs rendered before the CTA button. */
  body: string[];
  /** The note rendered after the CTA (expiry + "ignore if not yours"). */
  closingNote: string;
}

/** Build (without sending) the verification email's HTML, so the render is
 * testable — the screenshot suite captures exactly what this path sends. */
export function verificationEmailHtml(
  input: Pick<
    VerificationEmailInput,
    "token" | "origin" | "verifyPath" | "buttonLabel" | "body" | "closingNote"
  >,
): string {
  const link = verificationLink(input.origin, input.verifyPath, input.token);
  const home = appBase(input.origin);
  return emailShell({
    title: "Verify your email",
    body: [
      ...input.body.map(paragraph),
      verifyButton(link, input.buttonLabel),
      paragraph(input.closingNote),
    ].join("\n"),
    footer: valuePropFooter(home),
  });
}

export async function sendVerificationEmail(
  input: VerificationEmailInput,
): Promise<boolean> {
  const link = verificationLink(input.origin, input.verifyPath, input.token);
  if (!link.startsWith("http")) {
    console.warn(
      "[verification-email] no public origin (set PUBLIC_URL) — cannot email a verify link for " +
        input.to,
    );
    return false;
  }
  return sendEmail({
    to: input.to,
    subject: input.subject,
    html: verificationEmailHtml(input),
  });
}
