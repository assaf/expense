import { escapeHtml } from "~/lib/escape";

/**
 * Shared HTML layout for the app's emails — the verification email
 * (sender-verification.server.ts) and the inbound reply emails
 * (inbound-email.server.ts). One place for the shell, paragraph styling, and
 * footers so the two builders can't drift apart.
 */

/** A body paragraph in the shared email style. */
export function paragraph(text: string): string {
  return `<p style="margin:8px 0">${text}</p>`;
}

/** The email shell: base typography + title heading + body + footer. */
export function emailShell(opts: {
  title: string;
  body: string;
  footer?: string;
}): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.55;color:#1f2937;max-width:560px">
<h2 style="font-size:18px;margin:0 0 12px">${opts.title}</h2>
${opts.body}
${opts.footer ?? SIMPLE_FOOTER}
</div>`;
}

/** The plain footer (inbound replies) — no link, no pitch. */
export const SIMPLE_FOOTER =
  '<p style="margin-top:20px;color:#6b7280;font-size:12px">Expense — receipts by email</p>';

/** The value-prop footer with a home-page link (verification emails). */
export function valuePropFooter(home: string): string {
  return `<p style="margin-top:20px;border-top:1px solid #e5e7eb;padding-top:12px;color:#6b7280;font-size:12px;line-height:1.5">
  <a href="${escapeHtml(home)}/" style="color:#2563eb;text-decoration:none;font-weight:600">Expense</a> — free expense tracking for tax season. Snap a photo, forward a receipt, or log mileage, and Expense sorts it into IRS Schedule C categories and ready-to-file reports.
</p>`;
}
