import {
  FORWARD_MARKERS,
  stripForwardedText,
  stripForwardHeader,
  type CidImage,
  type CidResolver,
  type RenderEmailOptions,
  type RenderTextEmailOptions,
} from "~/lib/email-render.server";
import { htmlToText } from "~/lib/receipt-render.server";
import { fetchPublicUrl } from "~/lib/ssrf.server";
export { isPrivateHost } from "~/lib/ssrf.server";
import { isImage, isPdf } from "~/lib/file-types";
import { countLabel, formatAmount, formatDate } from "~/lib/format";
import {
  resolveExtraction,
  tryKnownMerchantExtraction,
} from "~/lib/receipt-ai.server";
import type {
  AttachmentCandidate,
  ExtractionResult,
  KnownMerchant,
} from "~/lib/receipt-ai.server";
import {
  emailShell,
  paragraph,
  SIMPLE_FOOTER,
} from "~/lib/email-layout.server";
import { escapeHtml } from "~/lib/escape";
import { extractEmailAddress } from "~/lib/validation";
import type { SendEmailOptions } from "~/lib/reply.server";
import { upsertExpense } from "~/lib/db/expenses";
import { readExtractionContext } from "~/lib/db/extraction-context";
import {
  findPendingSenderRow,
  findVerifiedSenderAccount,
  readInboundEmail,
  upsertInboundEmail,
} from "~/lib/db/inbound";
import { addEmailRule } from "~/lib/db/email-rules";
import { readReportSummary } from "~/lib/db/reports";
import { saveImage, readImage } from "~/lib/images.server";
import { INBOUND_EMAIL_ADDRESS, PUBLIC_URL } from "~/lib/env";
import { newExpenseShell, type ReceiptExpense } from "~/lib/types";

/**
 * Inbound email pipeline (receipts by email).
 *
 * Flow: FastMail delivers a forwarded receipt to the Receipts folder (address
 * action) and pushes a JMAP StateChange; `processUnprocessedReceipts`
 * (`~/lib/inbound-fastmail.server`) drains the folder and calls
 * `processInboundEvent` with FastMail-backed collaborators (fetch/list/
 * download over JMAP via postal-mime). The pipeline determines the expense
 * date, picks the receipt (attachment or email body), extracts
 * merchant/amount/category via DeepSeek (with tesseract OCR fallback), stores
 * the receipt image, and creates the expense — scoped to the account whose
 * VERIFIED inbound sender matches the From address (an added-but-unverified
 * address gets a "verify first" reply and no import).
 *
 * When anything fails or the result is incomplete, a reply email explains
 * what happened. Successful imports don't email (the expense appears in the
 * app). Each email id (the JMAP id) is tracked in `inbound_emails` so a
 * concurrent push/cron drain never creates duplicate expenses.
 */

// --- Types -----------------------------------------------------------------

/** The pipeline's incoming-email metadata (FastMail JMAP id as email_id). */
export interface EmailReceivedData {
  email_id: string;
  created_at: string;
  from: string;
  to: string[];
  bcc: string[];
  cc: string[];
  received_for: string[];
  message_id: string;
  subject: string;
  attachments: {
    id: string;
    filename: string;
    content_type: string | null;
    content_disposition: string | null;
    content_id: string | null;
  }[];
}

/** Received email content fetched by the transport (FastMail JMAP / postal-mime). */
export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  created_at: string;
  message_id: string;
}

/** Attachment metadata from the transport (FastMail JMAP / postal-mime). */
export interface AttachmentMeta {
  id: string;
  filename: string;
  size: number | null;
  content_type: string | null;
  content_disposition: string | null;
  content_id: string | null;
  download_url: string | null;
  expires_at: string | null;
}

type ReceiptSource =
  | {
      kind: "attachment";
      buffer: Buffer;
      contentType: string;
      filename: string;
    }
  | { kind: "body"; text: string };

export type ProcessResult =
  | { status: "created"; expenseId: string }
  | { status: "partial"; expenseId: string; missing: string[] }
  | { status: "error"; error: string }
  | { status: "duplicate" }
  | { status: "unknown-sender" }
  | { status: "unverified-sender" }
  | { status: "self-reply" }
  | { status: "bounce"; failedRecipient?: string };

/** Injectable collaborators (fakes in tests, real implementations by default). */
export interface InboundDeps {
  fetchReceivedEmail(emailId: string): Promise<ReceivedEmail>;
  listAttachments(emailId: string): Promise<AttachmentMeta[]>;
  downloadAttachment(meta: AttachmentMeta): Promise<Buffer>;
  classifyAttachment(candidates: AttachmentCandidate[]): Promise<number | null>;
  extractReceipt(input: {
    accountId: string;
    text?: string;
    image?: { buffer: Buffer; mime: string };
    categories?: string[];
    reports?: string[];
  }): Promise<ExtractionResult>;
  extractFromImage(input: {
    accountId: string;
    buffer: Buffer;
    mime: string;
    categories?: string[];
    reports?: string[];
    knownMerchants?: ReadonlyMap<string, KnownMerchant>;
  }): Promise<{
    result: ExtractionResult;
    text: string;
    stored: { buffer: Buffer; mime: string };
  }>;
  renderReceiptImage(
    text: string,
    opts?: { subject?: string },
  ): Promise<Buffer>;
  renderEmailImage(html: string, opts?: RenderEmailOptions): Promise<Buffer>;
  renderTextEmail(text: string, opts?: RenderTextEmailOptions): Promise<Buffer>;
  /** Send a reply email; failures are logged inside the transport and never
   * throw — the pipeline treats replies as fire-and-forget. */
  sendReply(input: SendEmailOptions): Promise<void>;
}

// --- Date -------------------------------------------------------------------

/** Parse an RFC 2822 / human date string into YYYY-MM-DD (UTC). Null if invalid or in the future. */
export function parseDateString(s: string): string | null {
  let clean = s.trim();
  if (!clean) return null;
  // Gmail-style human dates use "at": "Tue, Jun 2, 2026 at 3:14 PM".
  clean = clean.replace(/\s+at\s+/gi, ", ");
  const t = Date.parse(clean);
  if (!Number.isFinite(t)) return null;
  if (t > Date.now() + 24 * 3600 * 1000) return null; // future → invalid
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Extract the original email's date from a forwarded-message quote in the
 * body. Handles the common forward formats:
 *  - Apple Mail / iOS: "Begin forwarded message:"
 *  - Gmail / Yahoo / Thunderbird: "----- Forwarded message -----"
 *  - Outlook: "From:/Sent:/Date:" header block with no marker
 * Returns null when no forwarded date can be parsed.
 */
export function extractDateFromForwardedText(text: string): string | null {
  if (!text) return null;

  // Marker-based: the quoted headers follow the marker (they may sit after
  // a blank line, e.g. Apple Mail). Scan a bounded region so a receipt's
  // body can't inject unrelated "Date:" lines, but long header blocks
  // (Outlook Cc/Bcc/disclaimer chains) still fit. The marker list is the
  // same one email-render.server.ts uses for stripping forward blocks.
  let region: string | null = null;
  for (const marker of FORWARD_MARKERS) {
    const m = text.match(marker);
    if (m?.index !== undefined) {
      region = text.slice(m.index, Math.min(m.index + 3_000, text.length));
      break;
    }
  }
  if (region) {
    return firstParsedDate(region, [
      /^\s*Date:\s*(.+)$/gim,
      /^\s*Sent:\s*(.+)$/gim,
    ]);
  }

  // Marker-less (Outlook/Live Mail): a "From:" line followed within a few
  // header lines by a "Date:" or "Sent:" line.
  return firstParsedDate(text, [
    /(?:^|\n)\s*From:\s*[^\n]+(?:\n\s*(?:To|Cc|Bcc|Subject):[^\n]*){0,8}\n\s*Date:\s*(.+)/gi,
    /(?:^|\n)\s*From:\s*[^\n]+(?:\n\s*(?:To|Cc|Bcc|Subject):[^\n]*){0,8}\n\s*Sent:\s*(.+)/gi,
  ]);
}

/** Return the first Date:/Sent: capture that parses as a valid date. */
function firstParsedDate(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      const date = parseDateString(m[1]!);
      if (date) return date;
    }
  }
  return null;
}

/** Extract the Date header from a forwarded .eml attachment. */
export function extractDateFromEml(emlText: string): string | null {
  const m = emlText.match(/^Date:\s*([^\n]{6,80})/m);
  if (!m) return null;
  return parseDateString(m[1]!);
}

/**
 * The expense date is the date of the original email being forwarded:
 * 1. the forwarded message's quoted Date (body) or the .eml attachment's Date
 * 2. fall back to the received email's own Date header / arrival time
 */
export function extractExpenseDate(
  email: Pick<ReceivedEmail, "text" | "html" | "headers" | "created_at">,
  emlText?: string,
): string {
  if (emlText) {
    const d = extractDateFromEml(emlText);
    if (d) return d;
  }
  const text = [email.text, email.html].filter(Boolean).join("\n");
  const fromBody = extractDateFromForwardedText(text);
  if (fromBody) return fromBody;
  const headerDate = email.headers?.date ?? email.headers?.Date ?? "";
  const fromHeader = parseDateString(headerDate);
  if (fromHeader) return fromHeader;
  const fromArrival = parseDateString(email.created_at);
  return fromArrival ?? "";
}

// --- Attachment selection ----------------------------------------------------

/** AttachmentMeta-level wrappers over the shared file-type checks. */
function isPdfMeta(meta: AttachmentMeta): boolean {
  return isPdf({ mime: meta.content_type ?? "", originalName: meta.filename });
}

function isImageMeta(meta: AttachmentMeta): boolean {
  return isImage({
    mime: meta.content_type ?? "",
    originalName: meta.filename,
  });
}

function isEmlMeta(meta: AttachmentMeta): boolean {
  return (
    (meta.content_type ?? "").toLowerCase() === "message/rfc822" ||
    /\.eml$/i.test(meta.filename)
  );
}

/**
 * Heuristic score: PDFs and images are candidates; logos/signatures (tiny,
 * inline, or named) are penalized; inline images referenced by the HTML
 * (`cid:` in an <img>) are boosted — that is often the receipt itself.
 */
export function scoreAttachment(meta: AttachmentMeta, html: string): number {
  let score = 0;
  if (isPdfMeta(meta)) score += 2;
  else if (isImageMeta(meta)) score += 1;
  else return -Infinity;

  if (meta.content_disposition?.toLowerCase() === "attachment") score += 1;
  const referenced =
    Boolean(meta.content_id) && html.includes(`cid:${meta.content_id}`);
  if (referenced) score += 2;

  const name = meta.filename.toLowerCase();
  if (/receipt|invoice|order|confirmation|statement|purchase/.test(name)) {
    score += 2;
  }
  if (
    /logo|signature|\bsig\b|banner|icon|header|footer|favicon|badge|tracking-pixel/.test(
      name,
    )
  ) {
    score -= 4;
  }

  const size = meta.size ?? 0;
  if (isImageMeta(meta) && size > 0) {
    if (size < 20_000)
      score -= 3; // logo / signature territory
    else if (size < 50_000) score -= 1;
  }
  return score;
}

interface AttachmentPick {
  index: number;
  score: number;
  ambiguous: boolean;
}

/**
 * Rank the receipt candidates (PDFs + images). Returns the best candidate,
 * or null when nothing looks like a receipt (fall back to the email body).
 * `ambiguous` is true when a second candidate is close enough that the LLM
 * should decide.
 */
export function pickReceiptAttachment(
  attachments: AttachmentMeta[],
  html: string,
): AttachmentPick | null {
  const ranked = attachments
    .map((meta, index) => ({ index, meta, score: scoreAttachment(meta, html) }))
    .filter((c) => Number.isFinite(c.score))
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return null;
  const top = ranked[0]!;
  if (top.score <= 0) return null;
  const second = ranked[1];
  const ambiguous = Boolean(second && top.score - second.score < 2);
  return { index: top.index, score: top.score, ambiguous };
}

/** The receipt image to embed in the confirmation reply: base64 content for
 * The receipt image attached to the confirmation reply (base64 content +
 * filename). undefined when the import produced no stored image. */
async function receiptImageAttachment(
  accountId: string,
  imageFile: string,
): Promise<{ content: string; filename: string } | undefined> {
  if (!imageFile) return undefined;
  const stored = await readImage(accountId, imageFile);
  if (!stored) return undefined;
  return {
    content: stored.buffer.toString("base64"),
    filename: stored.mime === "image/jpeg" ? "receipt.jpg" : "receipt.png",
  };
}

// --- Reply email builders ----------------------------------------------------

/** The envelope shared by every pipeline reply: reply to the sender,
 * threaded to the original message. */
function replyEnvelope(data: EmailReceivedData): {
  to: string;
  inReplyTo: string | undefined;
} {
  return {
    to: data.from,
    inReplyTo: data.message_id,
  };
}

function replyHtml(title: string, paragraphs: string[]): string {
  return emailShell({
    title,
    body: paragraphs.map(paragraph).join(""),
    footer: SIMPLE_FOOTER,
  });
}

/** The fields extracted for a receipt, with a dash for any blank value. */
function fieldRow(label: string, value: string): string {
  return `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td><td style="padding:4px 0">${escapeHtml(value || "\u2014")}</td></tr>`;
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
  /** Intro line — defaults to the forward-flow wording; the
   * connected-account flow passes its own. */
  intro?: string;
  reportStats?: {
    before: { count: number; total: string };
    after: { count: number; total: string };
  };
}

/** Build the confirmation email for a receipt import (partial or complete). */
function confirmationHtml(
  opts: ConfirmationEmailOptions,
  subject: string,
): string {
  const editUrl = PUBLIC_URL ? `${PUBLIC_URL}/expense/${opts.expenseId}` : "";
  const rows = [
    fieldRow("Date", formatDate(opts.date, { long: true })),
    fieldRow("Merchant", opts.merchant),
    fieldRow("Amount", opts.amount ? formatAmount(opts.amount) : ""),
    fieldRow("Category", opts.category),
    fieldRow("Report", opts.report),
    ...(opts.description ? [fieldRow("Description", opts.description)] : []),
  ].join("");

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

/** The subject and HTML for a confirmation reply, so the subject line and
 * the in-body heading always match. Exported for the connected-account
 * pipeline, which sends the same confirmation to the mailbox owner. */
export function confirmationEmail(opts: ConfirmationEmailOptions): {
  subject: string;
  html: string;
} {
  const subject = confirmationSubject({
    amount: opts.amount,
    category: opts.category,
    report: opts.report,
    missing: opts.missing,
  });
  return { subject, html: confirmationHtml(opts, subject) };
}

// --- Bounce / auto-reply detection ------------------------------------------
//
// Delivery-status notifications (bounces) arrive when one of OUR outbound
// replies fails. Without a guard, a bounce looks like an unknown sender and
// gets a "sender not recognized" reply — which itself bounces, which gets
// another reply, looping forever and filling the Sent folder. Autoresponders
// (vacation notices, delivery receipts) are the same trap: they reply to
// every message, so replying to them is also an infinite loop.
//
// Two layers: a cheap check on metadata that exists before any fetch (DSN
// subject lines and daemon senders — catches Fastmail's own bounces), and a
// header check after fetch (null Return-Path, multipart/report, Auto-Submitted
// — catches DSNs that arrive with a spoofed From and autoresponder loops).

/** Subject lines of standard delivery-status / bounce notifications. */
const BOUNCE_SUBJECT_RE =
  /undelivered mail|delivery status notification|mail delivery (failed|failure|subsystem)|returned mail|failure notice|message.{0,12}bounc|bounced message|auto[-\s]?(reply|responder)|out of office|vacation (reply|notice)/i;

/** Bounce daemon senders, matched against the extracted address. */
const BOUNCE_SENDER_RE =
  /^(?:mailer-daemon|mail delivery system|postmaster|root)@/i;

/** Is this email a bounce/autoreply, from metadata alone (no fetch)? */
export function looksLikeBounce(
  data: Pick<EmailReceivedData, "from" | "subject">,
): boolean {
  return (
    BOUNCE_SUBJECT_RE.test(data.subject) ||
    BOUNCE_SENDER_RE.test(extractEmailAddress(data.from))
  );
}

/** Is this email a DSN/autoreply, from parsed headers (after fetch)? */
export function isDeliveryNotification(
  headers: Record<string, string>,
): boolean {
  const contentType = (headers["content-type"] ?? "").toLowerCase();
  if (
    contentType.includes("multipart/report") ||
    contentType.includes("message/delivery-status")
  ) {
    return true;
  }
  if ((headers["return-path"] ?? "").trim() === "<>") return true;
  const autoSubmitted = (headers["auto-submitted"] ?? "").toLowerCase();
  if (autoSubmitted.startsWith("auto-")) return true;
  return false;
}

/** Match a delivery-status body for the failed recipient. The address may
 * appear bare, in angle brackets, or after a display name — captures are
 * `<?addr>` and trailing punctuation is trimmed by `cleanBounceAddress`. */
const BOUNCE_RECIPIENT_PATTERNS: RegExp[] = [
  // delivery-status field: "Final-Recipient: rfc822; user@example.com"
  /(?:final|original)-recipient\s*:\s*(?:rfc822|smtp)\s*;\s*<?([^\s,;<>]+@[^\s,;<>]+)>?/i,
  // "user@example.com could not be delivered" / "failed to deliver to ..."
  /(?:could not be delivered|failed to deliver|was not delivered|undeliverable)(?:\s+to)?\s*[:\s]+<?([^\s,;<>"']+@[^\s,;<>"']+)>?/i,
  // "The following address(es) failed:" / "... could not be delivered:"
  // with the address on the same or a following line.
  /the following (?:address|recipient)(?:es)?[^:\n]*:\s*\n?\s*<?([^\s,;<>"']+@[^\s,;<>"']+)>?/i,
  // "Address failed:" / "Recipient could not be delivered: ..."
  /(?:address|recipient)(?:es)?\s+(?:that\s+)?(?:failed|could not be delivered)\s*:?\s*<?([^\s,;<>"']+@[^\s,;<>"']+)>?/i,
];

/** Trim trailing punctuation from an address pulled out of a DSN. */
function cleanBounceAddress(addr: string): string {
  return addr.replace(/[.,;:)\]>]+$/, "").trim();
}

/**
 * The failed recipient named by a delivery-status notification: the
 * X-Failed-Recipients header, a Final/Original-Recipient field in the DSN
 * body, a "failed to deliver" line, or the To header of the embedded
 * original message. Null when the bounce names no address — the caller
 * still drops the bounce either way; this is only for the log.
 */
async function bounceRecipient(
  email: Pick<ReceivedEmail, "text" | "html" | "headers">,
  attachments: AttachmentMeta[],
  deps: Pick<InboundDeps, "downloadAttachment">,
): Promise<string | null> {
  const header = email.headers["x-failed-recipients"];
  if (header) {
    const m = /([^\s,;<>]+@[^\s,;<>]+)/.exec(header);
    if (m) return cleanBounceAddress(m[1]!);
  }
  const body = [email.text, htmlToText(email.html ?? "")]
    .filter((t): t is string => Boolean(t))
    .join("\n");
  for (const re of BOUNCE_RECIPIENT_PATTERNS) {
    const m = body.match(re);
    if (m) return cleanBounceAddress(m[1]!);
  }
  // The embedded original message carries the To header of the failed send.
  const eml = attachments.find(isEmlMeta);
  if (eml && eml.size !== 0 && (eml.size ?? Infinity) < 1_000_000) {
    try {
      const text = (await deps.downloadAttachment(eml))
        .toString("utf8")
        .slice(0, 100_000);
      const to = /^[ \t]*To:[ \t]*(.+)$/im.exec(text);
      if (to) {
        const addr = /<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/i.exec(
          to[1]!,
        );
        if (addr) return cleanBounceAddress(addr[1]!);
      }
    } catch {
      // Best effort — a broken attachment must not fail the drain.
    }
  }
  return null;
}

/** Build the bounce result, best-effort naming the failed recipient. A
 * bounce must never fail the drain or trigger a reply. */
async function bounceResult(
  emailId: string,
  deps: InboundDeps,
): Promise<{ status: "bounce"; failedRecipient?: string }> {
  try {
    const [email, attachments] = await Promise.all([
      deps.fetchReceivedEmail(emailId),
      deps.listAttachments(emailId),
    ]);
    const failedRecipient =
      (await bounceRecipient(email, attachments, deps)) ?? undefined;
    return { status: "bounce", failedRecipient };
  } catch {
    return { status: "bounce" };
  }
}

// --- Pipeline ----------------------------------------------------------------

/**
 * Process one `email.received` webhook. Idempotent per email_id. Returns a
 * ProcessResult for the route to log; failure replies are sent by the
 * pipeline itself.
 */

// --- Rule learning from forwards ----------------------------------------------
//
// When a user forwards a receipt, the ORIGINAL sender (inside the forwarded
// content) becomes a user-specific email rule: future mail from that sender
// to a connected mailbox of the same workspace auto-imports.

/** The bare domain of an address ("a@b.example.com" -> "b.example.com"). */
function domainOf(address: string): string | null {
  const domain = address.split("@")[1]?.toLowerCase();
  return domain && domain.includes(".") ? domain : null;
}

const FORWARD_FROM_RE =
  /^[ \t]*From:[ \t]*(?:["']?[^"'\n<>]*["']?[ \t])?<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/im;

/**
 * The original sender inside a forwarded email: the From header of an .eml
 * attachment, else the first quoted "From:" line in the body. Null when the
 * forward carries no recognizable original sender.
 */
async function originalForwardedSender(
  email: Pick<ReceivedEmail, "text" | "html">,
  attachments: AttachmentMeta[],
  deps: Pick<InboundDeps, "downloadAttachment">,
): Promise<string | null> {
  const eml = attachments.find(isEmlMeta);
  if (eml && eml.size !== 0 && (eml.size ?? Infinity) < 1_000_000) {
    const text = (await deps.downloadAttachment(eml))
      .toString("utf8")
      .slice(0, 100_000);
    const match = text.match(FORWARD_FROM_RE);
    if (match) return domainOf(match[1]!);
  }
  const body = email.text || htmlToText(email.html ?? "");
  const match = body.match(FORWARD_FROM_RE);
  if (match) return domainOf(match[1]!);
  return null;
}

/** Learn a user rule from a successfully imported forward (best effort —
 * failures log a warning and never affect the import). */
async function learnRuleFromForward(
  accountId: string,
  email: Pick<ReceivedEmail, "text" | "html">,
  attachments: AttachmentMeta[],
  deps: Pick<InboundDeps, "downloadAttachment">,
): Promise<void> {
  try {
    const sender = await originalForwardedSender(email, attachments, deps);
    if (!sender) return;
    const result = await addEmailRule({ accountId, sender, source: "forward" });
    if (result.ok) {
      console.info("[inbound] learned email rule", { accountId, sender });
    }
  } catch (err) {
    console.warn("[inbound] email rule learning failed:", err);
  }
}

// --- Shared core (reused by the connected-email-accounts pipeline) ----------
//
// processInboundEvent is the receipts-by-email flow (verified forwarders,
// replies to the sender). The connected-account pipeline shares the heavy
// middle — pick the receipt source, extract, render, save the expense —
// through these three helpers, and differs in everything around them
// (rules instead of sender verification, Trash instead of destroy,
// notification to the mailbox owner instead of a reply to the sender).

/** The receipt source + the email's own date, picked from an email. */
interface SelectedReceiptSource {
  source: ReceiptSource | null;
  expenseDate: string;
}

/**
 * Pick what becomes the receipt: the best attachment (LLM tiebreak on
 * ambiguity), else the email body. Also resolves the expense date
 * (forwarded-quote → .eml → received header). `source` is null when
 * neither the email nor its attachments carry anything usable.
 */
export async function selectReceiptSource(
  email: ReceivedEmail,
  attachments: AttachmentMeta[],
  deps: InboundDeps,
): Promise<SelectedReceiptSource> {
  // Original email date: forwarded-quote → .eml → received header.
  const eml = attachments.find(isEmlMeta);
  let emlText: string | undefined;
  if (eml && eml.size !== 0 && (eml.size ?? Infinity) < 1_000_000) {
    emlText = (await deps.downloadAttachment(eml))
      .toString("utf8")
      .slice(0, 100_000);
  }
  const expenseDate = extractExpenseDate(email, emlText);

  // Pick the receipt: best attachment, LLM tiebreak, else the email body.
  const pick = pickReceiptAttachment(attachments, email.html ?? "");
  let source: ReceiptSource | null = null;
  if (pick && !pick.ambiguous) {
    const meta = attachments[pick.index]!;
    const buffer = await deps.downloadAttachment(meta);
    source = {
      kind: "attachment",
      buffer,
      contentType: meta.content_type ?? "",
      filename: meta.filename,
    };
  } else if (pick?.ambiguous) {
    const candidates: AttachmentCandidate[] = attachments
      .map((meta, index) => ({
        index,
        filename: meta.filename,
        contentType: meta.content_type ?? "",
        size: meta.size,
        inline: meta.content_disposition?.toLowerCase() === "inline",
        referenced:
          Boolean(meta.content_id) &&
          Boolean(email.html?.includes(`cid:${meta.content_id}`)),
      }))
      .filter(
        (c) =>
          isPdf({ mime: c.contentType, originalName: c.filename }) ||
          isImage({ mime: c.contentType, originalName: c.filename }),
      );
    const chosen = await deps.classifyAttachment(candidates);
    if (chosen !== null && attachments[chosen]) {
      const meta = attachments[chosen]!;
      const buffer = await deps.downloadAttachment(meta);
      source = {
        kind: "attachment",
        buffer,
        contentType: meta.content_type ?? "",
        filename: meta.filename,
      };
    }
  }
  if (!source) {
    const bodyText = (email.text || htmlToText(email.html ?? "")).trim();
    if (bodyText) source = { kind: "body", text: bodyText };
  }
  return { source, expenseDate };
}

/** Extraction output for a picked receipt source. */
interface ExtractedReceipt {
  extraction: ExtractionResult;
  receiptImage: Buffer | null;
  imageMime: string;
  originalName: string;
  renderError: string;
}

/**
 * Extract the receipt data from the picked source: OCR for attachments,
 * known-merchant fast path or the model for body text, with the rendered
 * email as the receipt image. Returns null when the content isn't a
 * receipt (the caller decides what to tell the user).
 */
export async function extractReceiptFromSource(opts: {
  accountId: string;
  email: ReceivedEmail;
  attachments: AttachmentMeta[];
  source: ReceiptSource;
  deps: InboundDeps;
}): Promise<ExtractedReceipt | null> {
  const { email, attachments, source, deps } = opts;
  const context = await readExtractionContext(opts.accountId);
  let extraction: ExtractionResult;
  let receiptImage: Buffer | null = null;
  let imageMime: string;
  let originalName: string;
  let renderError = "";

  if (source.kind === "attachment") {
    const { buffer, contentType, filename } = source;
    // extractFromImage handles PDFs (rasterizes to PNG and prefers the
    // text layer) and normalizes other images to a browser-displayable
    // form; `stored` is the bytes saved as the receipt image.
    const ocr = await deps.extractFromImage({
      accountId: opts.accountId,
      buffer,
      mime: contentType || "application/octet-stream",
      categories: context.categories,
      reports: context.reports,
      knownMerchants: context.knownMerchants,
    });
    extraction = ocr.result;
    receiptImage = ocr.stored.buffer;
    imageMime = ocr.stored.mime;
    // The stored bytes are always displayable: PDFs and HEIC/BMP/TIFF
    // inputs come back as PNG, so the stored name gets a .png extension.
    originalName = /\.pdf$/i.test(filename)
      ? filename.replace(/\.pdf$/i, ".png")
      : imageMime === "image/png" &&
          /\.(heic|heif|bmp|tiff?|avif)$/i.test(filename)
        ? filename.replace(/\.(heic|heif|bmp|tiff?|avif)$/i, ".png")
        : filename;
  } else {
    const bodyText = stripForwardedText(source.text).slice(0, 20_000);
    // Render the actual email with headless Chromium — the HTML part when
    // present, otherwise the plain text as a narrow email-style column.
    // The resvg text sheet stays as the final fallback (e.g. a runtime
    // without a browser binary). The forward-quote header block is
    // stripped first so the receipt image shows the receipt, not the
    // envelope.
    const cleanHtml = stripForwardHeader(email.html ?? "");
    if (cleanHtml) {
      try {
        receiptImage = await deps.renderEmailImage(cleanHtml, {
          resolveImage: makeCidResolver(attachments, cleanHtml, deps),
          fetchRemoteImage: fetchRemoteImageImpl,
        });
      } catch (err) {
        renderError = err instanceof Error ? err.message : String(err);
        receiptImage = null;
      }
    } else {
      try {
        receiptImage = await deps.renderTextEmail(bodyText, {
          subject: email.subject,
          from: email.from,
        });
      } catch (err) {
        renderError = err instanceof Error ? err.message : String(err);
        receiptImage = null;
      }
    }
    if (!receiptImage) {
      try {
        receiptImage = await deps.renderReceiptImage(bodyText, {
          subject: email.subject,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        renderError = renderError ? `${renderError}; ${message}` : message;
        receiptImage = null;
      }
    }
    imageMime = "image/png";
    originalName = "email-receipt.png";
    // Known-merchant skip: the body names a merchant the account has spent
    // with before and carries a parseable total — no model call needed.
    extraction =
      tryKnownMerchantExtraction(bodyText, context.knownMerchants) ??
      (await deps.extractReceipt({
        accountId: opts.accountId,
        text: bodyText,
        categories: context.categories,
        reports: context.reports,
      }));
    if (renderError) {
      console.error("[inbound] email receipt render failed:", renderError);
    }
  }

  // Classify as receipt? If the model says it isn't one and gave nothing
  // usable, don't create an expense.
  const hasUsableData = Boolean(extraction.merchant || extraction.amount);
  if (!extraction.isReceipt && !hasUsableData) {
    return null;
  }
  return { extraction, receiptImage, imageMime, originalName, renderError };
}

/** Before/after report stats for the confirmation email. */
interface ReportSummaryStats {
  before: { count: number; total: string };
  after: { count: number; total: string };
}

/** A saved expense plus everything its confirmation email needs. */
interface SavedExpense {
  expenseId: string;
  missing: string[];
  category: string;
  report: string;
  reportStats?: ReportSummaryStats;
  receiptAttachment?: { content: string; filename: string };
}

/** Build and save the expense from extracted data (date always comes from
 * the email, never the model); returns what the confirmation email needs. */
export async function saveExpenseFromExtraction(opts: {
  accountId: string;
  expenseDate: string;
  extraction: ExtractionResult;
  receiptImage: Buffer | null;
  imageMime: string;
  originalName: string;
}): Promise<SavedExpense> {
  const { extraction, receiptImage } = opts;
  const missing: string[] = [];
  if (!opts.expenseDate) missing.push("date");
  if (!extraction.merchant) missing.push("merchant");
  if (!extraction.amount) missing.push("amount");

  let imageFile = "";
  let imageMime = opts.imageMime;
  if (receiptImage) {
    const saved = await saveImage(
      opts.accountId,
      receiptImage,
      imageMime,
      opts.originalName,
    );
    imageFile = saved.filename;
    // saveImage may have re-encoded the format (e.g. PNG → JPEG) — record
    // the mime of the bytes actually stored, not the renderer's mime.
    imageMime = saved.mime;
  } else {
    missing.push("receipt image");
  }

  const context = await readExtractionContext(opts.accountId);
  const { category, report } = resolveExtraction(context, {
    merchant: extraction.merchant,
    category: extraction.category,
    report: extraction.report,
  });
  if (!category) missing.push("category");

  const expense: ReceiptExpense = {
    ...(newExpenseShell("receipt") as ReceiptExpense),
    date: opts.expenseDate,
    report,
    category,
    description: extraction.description,
    amount: extraction.amount,
    merchant: extraction.merchant,
    imageFile,
    imageMime,
    originalName: opts.originalName,
  };
  await upsertExpense(expense, opts.accountId);

  // The receipt image for the confirmation email (base64 attachment).
  const receiptAttachment = await receiptImageAttachment(
    opts.accountId,
    imageFile,
  );

  // Compute report before/after stats when a report is assigned.
  let reportStats: ReportSummaryStats | undefined;
  if (report) {
    const summary = await readReportSummary(opts.accountId, report);
    if (summary) {
      const amt = extraction.amount ? Number(extraction.amount) : 0;
      reportStats = {
        before: {
          count: summary.count - 1,
          total: (Number(summary.total) - amt).toFixed(2),
        },
        after: { count: summary.count, total: summary.total },
      };
    }
  }

  return {
    expenseId: expense.id,
    missing,
    category,
    report,
    reportStats,
    receiptAttachment,
  };
}

export async function processInboundEvent(
  data: EmailReceivedData,
  deps: InboundDeps,
): Promise<ProcessResult> {
  const subject = data.subject ?? "";
  const fromEmail = extractEmailAddress(data.from);

  // Self-reply guard: if the sender is the receipts address (what the app
  // sends replies FROM), this is an outbound reply looping back. Skip it
  // without sending another reply (which would itself loop back, creating
  // an infinite chain).
  if (fromEmail === INBOUND_EMAIL_ADDRESS) {
    return { status: "self-reply" };
  }

  // Bounce guard: a delivery-status notification is one of OUR replies that
  // failed. Never import it and never answer it — replying to a bounce (or
  // to an autoresponder) starts a reply→bounce→reply loop that fills Sent.
  // This check runs before the sender resolution so Fastmail's own
  // MAILER-DAEMON bounces never reach the "unknown sender" reply path.
  if (looksLikeBounce(data)) {
    // Never import and never answer a bounce, but name the failed recipient
    // for the log (best effort — fetch/extraction failures still drop it).
    return await bounceResult(data.email_id, deps);
  }

  // Only VERIFIED sender addresses accept receipts. A sender row that was
  // added but never verified gets a "verify first" reply instead of an
  // import; an address with no row at all is the unknown-sender case.
  const verified = await findVerifiedSenderAccount(fromEmail);
  if (!verified) {
    const pending = await findPendingSenderRow(fromEmail);
    if (pending) {
      await deps.sendReply({
        ...replyEnvelope(data),
        subject: "⚠️ Receipt not imported — sender not verified yet",
        html: replyHtml("Receipt not imported — verify this address first", [
          `We received your email${subject ? ` “${escapeHtml(subject)}”` : ""} from <b>${escapeHtml(data.from)}</b>, but this address hasn't been verified yet, so receipts from it are not imported.`,
          "Check the inbox of that address for the verification email we sent, or open the app and go to <b>Settings → Receipts by email</b> to resend it. Then forward the receipt again.",
        ]),
      });
      return { status: "unverified-sender" };
    }
    await deps.sendReply({
      ...replyEnvelope(data),
      subject: "⚠️ Receipt not imported — sender not recognized",
      html: replyHtml("Receipt not imported", [
        `We received your email${subject ? ` “${escapeHtml(subject)}”` : ""} but the sender address <b>${escapeHtml(data.from)}</b> is not set up to import receipts.`,
        "Open the app, go to <b>Settings → Receipts by email</b>, and add this address to the list of allowed senders. Then forward the receipt again.",
      ]),
    });
    return { status: "unknown-sender" };
  }
  const account = verified.account;

  const existing = await readInboundEmail(data.email_id);
  if (existing?.status === "created" || existing?.status === "partial") {
    return { status: "duplicate" };
  }
  // Remember whether this email already failed once: the first failure
  // emails the sender, but webhook retries (after the route's non-2xx
  // response) must not send a second, duplicate error reply.
  const previousStatus = existing?.status;
  await upsertInboundEmail({
    emailId: data.email_id,
    accountId: account.id,
    subject,
    status: "processing",
    error: "",
  });

  const fail = async (
    error: string,
    paragraphs: string[],
  ): Promise<ProcessResult> => {
    if (previousStatus !== "error") {
      await deps.sendReply({
        ...replyEnvelope(data),
        subject: "⚠️ Receipt not imported — something went wrong",
        html: replyHtml("Receipt not imported", paragraphs),
      });
    }
    await upsertInboundEmail({
      emailId: data.email_id,
      accountId: account.id,
      subject,
      status: "error",
      error,
    });
    return { status: "error", error };
  };

  try {
    const [email, attachments] = await Promise.all([
      deps.fetchReceivedEmail(data.email_id),
      deps.listAttachments(data.email_id),
    ]);

    // Header-level DSN/autoreply check: bounces whose From is spoofed or
    // whose subject is clean still carry a null Return-Path, a
    // multipart/report body, or an Auto-Submitted header. Skip those too.
    if (isDeliveryNotification(email.headers)) {
      const failedRecipient =
        (await bounceRecipient(email, attachments, deps)) ?? undefined;
      return { status: "bounce", failedRecipient };
    }

    const selected = await selectReceiptSource(email, attachments, deps);
    if (!selected.source) {
      return await fail("No receipt found", [
        `We couldn't find a receipt in the email${subject ? ` \u201c${escapeHtml(subject)}\u201d` : ""} or in any of its attachments.`,
        "Forward the receipt email again, or add the expense manually in the app.",
      ]);
    }

    const extracted = await extractReceiptFromSource({
      accountId: account.id,
      email,
      attachments,
      source: selected.source,
      deps,
    });
    if (!extracted) {
      return await fail("Not a receipt", [
        `The email${subject ? ` \u201c${escapeHtml(subject)}\u201d` : ""} doesn't look like a receipt, invoice, or order confirmation, so nothing was imported.`,
        "Forward the receipt email again, or add the expense manually in the app.",
      ]);
    }

    const saved = await saveExpenseFromExtraction({
      accountId: account.id,
      expenseDate: selected.expenseDate,
      extraction: extracted.extraction,
      receiptImage: extracted.receiptImage,
      imageMime: extracted.imageMime,
      originalName: extracted.originalName,
    });
    const { missing, category, report } = saved;
    const expenseDate = selected.expenseDate;
    const extraction = extracted.extraction;
    const renderError = extracted.renderError;
    const receiptAttachment = saved.receiptAttachment;
    const reportStats = saved.reportStats;
    const expenseId = saved.expenseId;

    if (missing.length > 0) {
      const confirmation = confirmationEmail({
        expenseId,
        date: expenseDate,
        merchant: extraction.merchant,
        amount: extraction.amount,
        category,
        report,
        description: extraction.description,
        notes: [
          extraction.notes,
          extraction.currency && extraction.currency !== "USD"
            ? `Amount is in ${extraction.currency} \u2014 the app assumes USD.`
            : "",
          renderError
            ? `The email body could not be rendered as a receipt image (${renderError}). You can attach a photo in the app.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        missing,
        reportStats,
      });
      await deps.sendReply({
        ...replyEnvelope(data),
        subject: confirmation.subject,
        html: confirmation.html,
        attachments: receiptAttachment ? [receiptAttachment] : undefined,
      });
      await learnRuleFromForward(account.id, email, attachments, deps);
      await upsertInboundEmail({
        emailId: data.email_id,
        accountId: account.id,
        subject,
        status: "partial",
        error: `Missing: ${missing.join(", ")}`,
      });
      return { status: "partial", expenseId, missing };
    }

    // Successful import — send a confirmation email with the details.
    const confirmation = confirmationEmail({
      expenseId,
      date: expenseDate,
      merchant: extraction.merchant,
      amount: extraction.amount,
      category,
      report,
      description: extraction.description,
      notes: [
        extraction.notes,
        extraction.currency && extraction.currency !== "USD"
          ? `Amount is in ${extraction.currency} \u2014 the app assumes USD.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      missing: [],
      reportStats,
    });
    await deps.sendReply({
      ...replyEnvelope(data),
      subject: confirmation.subject,
      html: confirmation.html,
      attachments: receiptAttachment ? [receiptAttachment] : undefined,
    });

    await learnRuleFromForward(account.id, email, attachments, deps);
    await upsertInboundEmail({
      emailId: data.email_id,
      accountId: account.id,
      subject,
      status: "created",
      error: "",
    });
    return { status: "created", expenseId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[inbound] processing failed:", err);
    return await fail(message, [
      `The email${subject ? ` “${escapeHtml(subject)}”` : ""} could not be processed: <b>${escapeHtml(message)}</b>`,
      "Fix the problem and forward the receipt again, or add the expense manually in the app.",
    ]);
  }
}

/**
 * Resolve `cid:` image references in the email HTML to base64 data URIs so
 * the browser render is self-contained (the renderer blocks the network, so
 * unrewritten cid: refs would show as broken images). Only inline
 * attachments actually referenced by the HTML are downloaded, bounded by
 * count and size.
 */ function makeCidResolver(
  attachments: AttachmentMeta[],
  html: string,
  deps: InboundDeps,
): CidResolver {
  const wanted = attachments.filter(
    (a) => a.content_id && html.includes(`cid:${a.content_id}`),
  );
  const cache = new Map<string, CidImage>();
  return async (cid: string): Promise<CidImage | null> => {
    const cached = cache.get(cid);
    if (cached) return cached;
    const meta = wanted.find((a) => a.content_id === cid);
    if (!meta || cache.size >= 8) return null;
    try {
      const buffer = await deps.downloadAttachment(meta);
      if (buffer.length > 5_000_000) return null;
      const image = { buffer, mime: meta.content_type || "image/png" };
      cache.set(cid, image);
      return image;
    } catch {
      return null;
    }
  };
}

// --- Remote images (http(s) refs in the email HTML) --------------------------

const REMOTE_IMAGE_MAX_BYTES = 5_000_000; // per-image cap
const REMOTE_IMAGE_TIMEOUT_MS = 4_000;
const REMOTE_IMAGE_REDIRECTS = 3;

/** Pre-fetch a remote image referenced by the email HTML so it can be
 * inlined as a data URI (the renderer blocks all network). Returns null for
 * anything non-image, oversized, timed out, or pointing at a private host.
 * The fetch itself is SSRF-guarded (http(s) only, private/resolved-private
 * hosts rejected, redirects re-checked at every hop — see ssrf.server). */
export async function fetchRemoteImageImpl(
  url: string,
): Promise<CidImage | null> {
  let res: Response;
  try {
    res = await fetchPublicUrl(url, {
      timeoutMs: REMOTE_IMAGE_TIMEOUT_MS,
      redirects: REMOTE_IMAGE_REDIRECTS,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!/^image\//i.test(type)) return null;
  if (Number(res.headers.get("content-length") ?? 0) > REMOTE_IMAGE_MAX_BYTES) {
    return null;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0 || buffer.length > REMOTE_IMAGE_MAX_BYTES) {
    return null;
  }
  return { buffer, mime: type || "image/png" };
}
