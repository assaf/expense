/**
 * Confirmation email builders for receipt imports, shared by the
 * receipts-by-email pipeline (sent to the SENDER) and the connected-account
 * pipeline (imported into the OWNER's Inbox).
 *
 * The confirmation carries the extracted details plus the ORIGINAL receipt:
 * a body-source receipt is quoted verbatim below the details (HTML
 * blockquote + ">"-prefixed plain text, capped at QUOTED_ORIGINAL_MAX_CHARS);
 * an attachment-source receipt carries the original file, built by the
 * caller (`saveExpenseFromExtraction` in inbound-email.server.ts).
 */
import { escapeHtml } from "~/lib/escape";
import { countLabel, formatAmount, formatDate } from "~/lib/format";
import { emailShell, SIMPLE_FOOTER } from "~/lib/email-layout.server";
import { PUBLIC_URL } from "~/lib/env";

/** The fields extracted for a receipt, with a dash for any blank value. */
function fieldRow(label: string, value: string): string {
  return `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td><td style="padding:4px 0">${escapeHtml(value || "\u2014")}</td></tr>`;
}

/** The confirmation's field list (label + display value), shared by the
 * HTML and plain-text renderers so a new field can't drift between them. */
function confirmationFields(
  opts: ConfirmationEmailOptions,
): [string, string][] {
  return [
    ["Date", formatDate(opts.date, { long: true })],
    ["Merchant", opts.merchant],
    ["Amount", opts.amount ? formatAmount(opts.amount) : ""],
    ["Category", opts.category],
    ["Report", opts.report],
    ...(opts.description
      ? ([["Description", opts.description]] as [string, string][])
      : []),
  ];
}

/** Longest original-receipt text quoted in a confirmation reply: the
 * parsed email body can be a whole thread; a receipt is never this big. */
const QUOTED_ORIGINAL_MAX_CHARS = 4000;

/** The quoted-original text, capped at QUOTED_ORIGINAL_MAX_CHARS. Returns
 * the text to quote and whether it was truncated (the renderers append a
 * truncation note). */
function cappedQuotedOriginal(text: string): {
  quoted: string;
  truncated: boolean;
} {
  const truncated = text.length > QUOTED_ORIGINAL_MAX_CHARS;
  return {
    quoted: truncated ? text.slice(0, QUOTED_ORIGINAL_MAX_CHARS) : text,
    truncated,
  };
}

/**
 * The reply subject: "👍 Receipt accepted: <amount> \u2014 <category> \u2014
 * <report>", each field only shown when known. Partial imports get a ⚠️
 * prefix and keep the needs-attention marker.
 */
function confirmationSubject(opts: {
  amount: string;
  category: string;
  report: string;
  missing: string[];
}): string {
  const parts: string[] = [];
  if (opts.amount) parts.push(formatAmount(opts.amount));
  if (opts.category) parts.push(opts.category);
  if (opts.report) parts.push(opts.report);
  const emoji = opts.missing.length > 0 ? "⚠️ " : "👍 ";
  let subject = `${emoji}Receipt accepted`;
  if (parts.length > 0) subject += `: ${parts.join(" \u2014 ")}`;
  if (opts.missing.length > 0) subject += " \u2014 needs attention";
  return subject;
}

/** The footer line summarizing how a report changed, or "" without a report. */
function reportChangeLine(opts: {
  report: string;
  reportStats?: {
    before: { count: number; total: string };
    after: { count: number; total: string };
  };
}): string {
  if (!opts.reportStats) return "";
  const { before, after } = opts.reportStats;
  const verb =
    Number(after.total) < Number(before.total) ? "decreased" : "increased";
  return `<p style="margin-top:20px;font-size:14px;font-weight:600;color:#1f2937">FYI: ${escapeHtml(opts.report)} ${verb} from ${countLabel(before.count)} / ${formatAmount(before.total)} to ${countLabel(after.count)} / ${formatAmount(after.total)}</p>`;
}

/** Options for the confirmation email (shared by both email pipelines). */
export interface ConfirmationEmailOptions {
  expenseId: string;
  date: string;
  merchant: string;
  amount: string;
  category: string;
  report: string;
  description: string;
  notes: string;
  missing: string[];
  /** Intro line; defaults to the forward-flow wording, and the
   * connected-account flow passes its own. */
  intro?: string;
  reportStats?: {
    before: { count: number; total: string };
    after: { count: number; total: string };
  };
  /** The original receipt text (a body-source receipt) to quote below the
   * details. The connected pipeline doesn't pass it, since the original email
   * already sits in the owner's Inbox. */
  quotedOriginal?: string;
}

/** Build the confirmation email for a receipt import (partial or complete). */
function confirmationHtml(
  opts: ConfirmationEmailOptions,
  subject: string,
): string {
  const editUrl = PUBLIC_URL ? `${PUBLIC_URL}/expense/${opts.expenseId}` : "";
  const rows = confirmationFields(opts)
    .map(([label, value]) => fieldRow(label, value))
    .join("");

  const blocks: string[] = [
    `<p style="margin:8px 0">${escapeHtml(
      opts.intro ?? "Thanks for forwarding your receipt. Here's what we found:",
    )}</p>`,
    `<table cellpadding="0" cellspacing="0" style="margin:12px 0">${rows}</table>`,
  ];

  if (opts.missing.length > 0) {
    blocks.push(
      `<p style="margin:8px 0;color:#92400e">These fields couldn't be determined: <b>${opts.missing.map(escapeHtml).join(", ")}</b>.</p>`,
    );
  }
  if (opts.notes) {
    blocks.push(
      `<p style="margin:8px 0;color:#6b7280;font-size:13px">${escapeHtml(opts.notes)}</p>`,
    );
  }
  if (opts.quotedOriginal) {
    // The original receipt, quoted verbatim below the details so the
    // sender can compare. Line breaks preserved; truncated for sanity.
    const { quoted, truncated } = cappedQuotedOriginal(opts.quotedOriginal);
    blocks.push(
      `<div style="margin:16px 0 4px;font-size:13px;font-weight:600;color:#374151">Original receipt</div>`,
      `<blockquote style="margin:0;padding:10px 14px;border-left:3px solid #d1d5db;background:#f9fafb;color:#374151;font-size:13px;line-height:1.5;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">${escapeHtml(quoted)}${truncated ? `<div style="margin-top:8px;color:#9ca3af">… receipt text truncated</div>` : ""}</blockquote>`,
    );
  }
  if (editUrl) {
    blocks.push(
      `<p style="margin:16px 0 0"><a href="${escapeHtml(editUrl)}" style="display:inline-block;padding:8px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Edit this receipt</a></p>`,
    );
  }

  return emailShell({
    title: subject,
    body: blocks.join(""),
    footer: `${reportChangeLine({ report: opts.report, reportStats: opts.reportStats })}${SIMPLE_FOOTER}`,
  });
}

/** The plain-text alternative for a confirmation: the same fields as the
 * HTML, then the original receipt quoted with ">" prefixes (the email
 * convention for quoted text). */
function confirmationText(opts: ConfirmationEmailOptions): string {
  const rows = confirmationFields(opts)
    .map(([label, value]) => `${label}: ${value || "\u2014"}`)
    .join("\n");

  const parts = [
    opts.intro ?? "Thanks for forwarding your receipt. Here's what we found:",
    rows,
  ];
  if (opts.missing.length > 0) {
    parts.push(
      `These fields couldn't be determined: ${opts.missing.join(", ")}.`,
    );
  }
  if (opts.notes) parts.push(opts.notes);
  if (opts.quotedOriginal) {
    const { quoted, truncated } = cappedQuotedOriginal(opts.quotedOriginal);
    parts.push(
      `Original receipt:\n${quoted
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}${truncated ? "\n> … receipt text truncated" : ""}`,
    );
  }
  return parts.join("\n\n");
}

/** The subject, HTML, and plain-text alternative for a confirmation reply,
 * so the subject line and the in-body heading always match. The plain text
 * mirrors the HTML for clients that don't render it, and carries the quoted
 * original receipt with ">" prefixes. Exported for the connected-account
 * pipeline, which sends the same confirmation to the mailbox owner. */
export function confirmationEmail(opts: ConfirmationEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = confirmationSubject({
    amount: opts.amount,
    category: opts.category,
    report: opts.report,
    missing: opts.missing,
  });
  return {
    subject,
    html: confirmationHtml(opts, subject),
    text: confirmationText(opts),
  };
}
/** The free-text notes under a confirmation's summary: the extraction's own
 * notes plus caveats (non-USD amount, body-render failure). Empty pieces
 * drop out. Shared by both pipelines' confirmation builders. */
export function confirmationNotes(opts: {
  notes?: string | null;
  currency?: string | null;
  renderError?: string | null;
}): string {
  return [
    opts.notes,
    opts.currency && opts.currency !== "USD"
      ? `Amount is in ${opts.currency} — the app assumes USD.`
      : "",
    opts.renderError
      ? `The email body could not be rendered as a receipt image (${opts.renderError}). You can attach a photo in the app.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
