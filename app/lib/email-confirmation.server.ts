/**
 * Confirmation email builders for receipt imports, shared by the
 * receipts-by-email pipeline (sent to the SENDER) and the connected-account
 * pipeline (imported into the OWNER's Inbox).
 *
 * The confirmation carries the extracted details plus the receipt itself:
 * above the details sits the image the app FILED for the expense — the
 * normalized render every import stores — and an original a client cannot
 * render (a PDF) is attached beside it, built by the caller
 * (`saveExpenseFromExtraction` in inbound-email.server.ts). The original
 * body text is not quoted: the image already shows the receipt.
 */
import { escapeHtml } from "~/lib/escape";
import { countLabel, formatAmount, formatDate } from "~/lib/format";
import { emailShell, SIMPLE_FOOTER } from "~/lib/email-layout.server";
import { PUBLIC_URL } from "~/lib/env";
import type { SendEmailInput } from "~/lib/email-mime.server";
import type { FxConversion } from "~/lib/fx.server";

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

/** Image types mail clients render inline. Any other receipt (a PDF, a HEIC
 * photo, an unrecognized blob) stays a plain attachment: an <img> pointing
 * at bytes the client can't decode renders as a broken image. */
const INLINE_IMAGE_TYPES: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/gif": true,
  "image/webp": true,
};

/** Can a mail client render a file of this type inline? The rule the
 * confirmation decides with: what it inlines, and whether an original it
 * cannot inline rides along as an attachment. The pipeline passes each
 * file's stored mime through rather than deciding, so this stays the one
 * place the set lives. */
function canInlineReceipt(contentType?: string): boolean {
  const type = contentType?.toLowerCase();
  return Boolean(type && INLINE_IMAGE_TYPES[type]);
}

/** The receipt file a confirmation carries: base64 content plus the name and
 * media type its MIME part is built from. */
export interface ConfirmationReceipt {
  content: string;
  filename: string;
  contentType?: string;
}

/** One MIME part of a confirmation: an inline image (with its Content-ID) or
 * a plain file attachment. */
type ConfirmationPart = NonNullable<SendEmailInput["attachments"]>[number];

/**
 * The parts a confirmation carries: the image the app filed for this expense,
 * plus the original file only when a mail client cannot show it.
 *
 * Every import stores an image — the normalized, smaller render the expense
 * page shows — whatever the receipt arrived as (a body, a screenshot, a PDF),
 * so that image is what the reader sees, in all three cases. The original
 * file rides along only when it is NOT something a client can render (a PDF):
 * an image already shown as the preview would be a duplicate part, and the
 * sender has their own copy anyway. Only a missing render falls back to
 * inlining the original.
 */
function confirmationParts(opts: {
  expenseId: string;
  receipt?: ConfirmationReceipt;
  preview?: ConfirmationReceipt;
}): { inline?: ConfirmationPart; attached?: ConfirmationReceipt } {
  const { receipt, preview } = opts;
  const shown = canInlineReceipt(preview?.contentType)
    ? preview
    : canInlineReceipt(receipt?.contentType)
      ? receipt
      : undefined;
  return {
    inline: shown
      ? { ...shown, contentId: receiptContentId(opts.expenseId) }
      : undefined,
    attached:
      receipt && !canInlineReceipt(receipt.contentType) ? receipt : undefined,
  };
}

/** The Content-ID the inline receipt image is referenced by. Derived from the
 * expense id so the HTML's `cid:` URL and the MIME part's Content-ID cannot
 * drift. */
function receiptContentId(expenseId: string): string {
  return `receipt-${expenseId}@expense.local`;
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
  /** The original receipt file. It is attached only when a client cannot
   * render it (a PDF): an image is shown anyway, through `preview`. Send the
   * bytes from the returned `attachments`, which carry the Content-ID that
   * the inline image is referenced by. */
  receipt?: ConfirmationReceipt;
  /** The image the app filed for this expense: the normalized JPEG/PNG the
   * expense page shows. This is what the confirmation inlines, whatever the
   * receipt arrived as. Falls back to `receipt` only when there is no stored
   * render. */
  preview?: ConfirmationReceipt;
}

/** Build the confirmation email for a receipt import (partial or complete). */
function confirmationHtml(
  opts: ConfirmationEmailOptions,
  subject: string,
  inlineCid?: string,
): string {
  const editUrl = PUBLIC_URL ? `${PUBLIC_URL}/expense/${opts.expenseId}` : "";
  const rows = confirmationFields(opts)
    .map(([label, value]) => fieldRow(label, value))
    .join("");

  const blocks: string[] = [
    `<p style="margin:8px 0">${escapeHtml(
      opts.intro ?? "Thanks for forwarding your receipt. Here's what we found:",
    )}</p>`,
  ];
  if (inlineCid) {
    // The receipt itself, above the fields: a glance tells the reader
    // whether the import is right, without opening an attachment.
    blocks.push(
      `<img src="cid:${escapeHtml(inlineCid)}" alt="Receipt" style="display:block;margin:12px 0;max-width:100%;height:auto;border:1px solid #e5e7eb;border-radius:8px">`,
    );
  }
  blocks.push(
    `<table cellpadding="0" cellspacing="0" style="margin:12px 0">${rows}</table>`,
  );

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
 * HTML. The image itself renders in the HTML, so a text-only reader gets the
 * name of each part instead. */
function confirmationText(
  opts: ConfirmationEmailOptions,
  inline?: ConfirmationPart,
  attached?: ConfirmationReceipt,
): string {
  const rows = confirmationFields(opts)
    .map(([label, value]) => `${label}: ${value || "\u2014"}`)
    .join("\n");

  const parts = [
    opts.intro ?? "Thanks for forwarding your receipt. Here's what we found:",
  ];
  if (inline) parts.push(`Receipt image attached: ${inline.filename}`);
  if (attached) {
    parts.push(`Original receipt attached: ${attached.filename}`);
  }
  parts.push(rows);
  if (opts.missing.length > 0) {
    parts.push(
      `These fields couldn't be determined: ${opts.missing.join(", ")}.`,
    );
  }
  if (opts.notes) parts.push(opts.notes);
  return parts.join("\n\n");
}

/** A built confirmation, ready to send: the subject/HTML/text plus the
 * receipt parts that go with them. */
export interface ConfirmationMessage {
  subject: string;
  html: string;
  text: string;
  /** What the message carries, in part order: the inline receipt image (the
   * receipt itself, or its preview) when the caller supplied something a
   * client can render, then the original file when it is not that image.
   * Pass to the sender unchanged. */
  attachments?: SendEmailInput["attachments"];
}

/** The subject, HTML, plain-text alternative, and attachments for a
 * confirmation reply, so the subject line and the in-body heading always
 * match, and the inline image's Content-ID cannot drift from the MIME part
 * that carries it. The plain text mirrors the HTML for clients that don't
 * render it, and carries the quoted original receipt with ">" prefixes.
 * Exported for the connected-account pipeline, which sends the same
 * confirmation to the mailbox owner. */
export function confirmationEmail(
  opts: ConfirmationEmailOptions,
): ConfirmationMessage {
  const subject = confirmationSubject({
    amount: opts.amount,
    category: opts.category,
    report: opts.report,
    missing: opts.missing,
  });
  const { inline, attached } = confirmationParts({
    expenseId: opts.expenseId,
    receipt: opts.receipt,
    preview: opts.preview,
  });
  return {
    subject,
    html: confirmationHtml(opts, subject, inline?.contentId),
    text: confirmationText(opts, inline, attached),
    attachments:
      inline || attached ? [inline, attached].filter(isPart) : undefined,
  };
}

/** Keep the defined parts, in order (inline first, then the original file). */
function isPart(part: ConfirmationPart | undefined): part is ConfirmationPart {
  return part !== undefined;
}
/** The free-text notes under a confirmation's summary: the extraction's own
 * notes plus caveats (foreign currency and its conversion, body-render
 * failure). Empty pieces drop out. Shared by both pipelines' confirmation
 * builders. */
export function confirmationNotes(opts: {
  notes?: string | null;
  /** The receipt's detected currency, "USD" when none was detected. */
  currency?: string | null;
  /** The conversion applied at import; null when the receipt was USD or no
   * exchange rate was available (the amount is then stored as-is). */
  fx?: FxConversion | null;
  renderError?: string | null;
}): string {
  return [
    opts.notes,
    opts.currency && opts.currency !== "USD"
      ? opts.fx
        ? `Receipt in ${opts.fx.currency}: ${opts.fx.currency} ${opts.fx.originalAmount} → $${opts.fx.amount} (ECB reference rate ${opts.fx.fxRate} on ${opts.fx.rateDate}).`
        : `Amount is in ${opts.currency} — no exchange rate was available, so it was stored as-is (treated as USD).`
      : "",
    opts.renderError
      ? `The email body could not be rendered as a receipt image (${opts.renderError}). You can attach a photo in the app.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
