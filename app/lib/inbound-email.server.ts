import { createHmac } from "node:crypto";
import { ulid } from "ulid";
import {
  FORWARD_MARKERS,
  renderEmailImage,
  renderTextEmail,
  stripForwardedText,
  stripForwardHeader,
  type CidImage,
  type CidResolver,
  type RenderEmailOptions,
  type RenderTextEmailOptions,
} from "~/lib/email-render.server";
import { htmlToText, renderReceiptImage } from "~/lib/receipt-render.server";
import { safeEqualBase64 } from "~/lib/passwords";
import { isImage, isPdf } from "~/lib/file-types";
import {
  classifyReceiptAttachment,
  extractReceipt,
  resolveCategory,
  resolveReport,
} from "~/lib/receipt-ai.server";
import type {
  AttachmentCandidate,
  ExtractionResult,
} from "~/lib/receipt-ai.server";
import { extractFromImage } from "~/lib/receipt-ocr.server";
import {
  emailShell,
  paragraph,
  SIMPLE_FOOTER,
} from "~/lib/email-layout.server";
import { escapeHtml } from "~/lib/escape";
import { extractEmailAddress } from "~/lib/validation";
import { sendReplyEmail } from "~/lib/reply.server";
import type { ReplyInput } from "~/lib/reply.server";
import {
  findPendingSenderRow,
  findVerifiedSenderAccount,
  readExtractionContext,
  readInboundEmail,
  readReportSummary,
  upsertExpense,
  upsertInboundEmail,
} from "~/lib/store.server";
import { saveImage } from "~/lib/images.server";
import { INBOUND_EMAIL_ADDRESS, PUBLIC_URL, RESEND_API_KEY } from "~/lib/env";
import type { ReceiptExpense } from "~/lib/types";

/**
 * Inbound email pipeline (receipts by email).
 *
 * Flow: Resend receives a forwarded email → POSTs an `email.received` webhook
 * (metadata only) → this module verifies the signature (in the route),
 * fetches the email body/headers/attachments from the Resend API, determines
 * the expense date, picks the receipt (attachment or email body), extracts
 * merchant/amount/category via DeepSeek (with tesseract OCR fallback), stores
 * the receipt image, and creates the expense — scoped to the account whose
 * VERIFIED inbound sender matches the From address (an added-but-unverified
 * address gets a "verify first" reply and no import).
 *
 * When anything fails or the result is incomplete, a reply email explains
 * what happened. Successful imports don't email (the expense appears in the
 * app). Each email_id is tracked in `inbound_emails` so Resend's webhook
 * retries never create duplicate expenses.
 */

// --- Types -----------------------------------------------------------------

/** The `data` object of Resend's `email.received` webhook. */
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

/** Received email content fetched from the Resend API. */
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

/** Attachment metadata from the Resend Attachments API. */
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
  | { status: "self-reply" };

/** Injectable collaborators (fakes in tests, real implementations by default). */
export interface InboundDeps {
  fetchReceivedEmail(emailId: string): Promise<ReceivedEmail>;
  listAttachments(emailId: string): Promise<AttachmentMeta[]>;
  downloadAttachment(meta: AttachmentMeta): Promise<Buffer>;
  classifyAttachment(candidates: AttachmentCandidate[]): Promise<number | null>;
  extractReceipt(input: {
    text?: string;
    image?: { buffer: Buffer; mime: string };
    categories?: string[];
    reports?: string[];
  }): Promise<ExtractionResult>;
  extractFromImage(input: {
    buffer: Buffer;
    mime: string;
    categories?: string[];
    reports?: string[];
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
  sendReply(input: ReplyInput): Promise<void>;
}

// --- Webhook signature (Svix format) ----------------------------------------

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * The expected Svix signature (base64, no `v1,` prefix) for a webhook:
 * HMAC-SHA256 of `<id>.<timestamp>.<rawBody>` keyed with the base64-decoded
 * part of the signing secret after the `whsec_` prefix.
 */
export function computeWebhookSignature(
  id: string,
  timestamp: string,
  rawBody: string,
  secret: string,
): string {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
}

/**
 * Verify a Resend webhook (standard Svix/Standard-Webhooks format):
 *  - headers `svix-id`, `svix-timestamp`, `svix-signature` (base64, space-
 *    delimited `v1,<sig>` entries)
 *  - signed content is `<id>.<timestamp>.<rawBody>`
 *  - HMAC-SHA256 key is the base64-decoded part of the signing secret after
 *    the `whsec_` prefix
 * Includes a 5-minute replay guard on the timestamp.
 */
export function verifyWebhookSignature(
  headers: WebhookHeaders,
  rawBody: string,
  secret: string,
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret) return false;
  const tsNum = Number(timestamp);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > 300) return false;

  const expected = computeWebhookSignature(id, timestamp, rawBody, secret);

  // The header is a space-delimited list like "v1,<sig> v1,<sig2> …".
  for (const entry of signature.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma <= 0) continue;
    const version = entry.slice(0, comma);
    const candidate = entry.slice(comma + 1);
    if (version !== "v1") continue;
    if (safeEqualBase64(expected, candidate)) return true;
  }
  return false;
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

// --- Default collaborators (real implementations) -----------------------------

async function resendGet(path: string): Promise<unknown> {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
  const res = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Resend API ${res.status} GET ${path}: ${body.slice(0, 300)}`,
    );
  }
  return res.json();
}

async function fetchReceivedEmailImpl(emailId: string): Promise<ReceivedEmail> {
  const data = (await resendGet(
    `/emails/receiving/${emailId}?html_format=cid`,
  )) as ReceivedEmail;
  return {
    ...data,
    headers: (data.headers ?? {}) as Record<string, string>,
    html: data.html ?? null,
    text: data.text ?? null,
  };
}

async function listAttachmentsImpl(emailId: string): Promise<AttachmentMeta[]> {
  const data = (await resendGet(
    `/emails/receiving/${emailId}/attachments`,
  )) as { data?: AttachmentMeta[] };
  return data.data ?? [];
}

async function downloadAttachmentImpl(meta: AttachmentMeta): Promise<Buffer> {
  if (!meta.download_url)
    throw new Error(`No download URL for ${meta.filename}`);
  const res = await fetch(meta.download_url);
  if (!res.ok) {
    throw new Error(
      `Attachment download failed ${res.status} for ${meta.filename}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

const defaultDeps: InboundDeps = {
  fetchReceivedEmail: fetchReceivedEmailImpl,
  listAttachments: listAttachmentsImpl,
  downloadAttachment: downloadAttachmentImpl,
  classifyAttachment: classifyReceiptAttachment,
  extractReceipt,
  extractFromImage,
  renderReceiptImage,
  renderEmailImage,
  renderTextEmail,
  sendReply: sendReplyEmail,
};

// --- Reply email builders ----------------------------------------------------

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

/** Build the confirmation email for a receipt import (partial or complete). */
function confirmationHtml(opts: {
  expenseId: string;
  date: string;
  merchant: string;
  amount: string;
  category: string;
  report: string;
  notes: string;
  missing: string[];
  reportStats?: {
    before: { count: number; total: string };
    after: { count: number; total: string };
  };
}): string {
  const editUrl = PUBLIC_URL ? `${PUBLIC_URL}/expense/${opts.expenseId}` : "";
  const rows = [
    fieldRow("Date", opts.date),
    fieldRow("Merchant", opts.merchant),
    fieldRow("Amount", opts.amount ? `$${opts.amount}` : ""),
    fieldRow("Category", opts.category),
    fieldRow("Report", opts.report),
  ].join("");

  const blocks: string[] = [
    `<p style="margin:8px 0">Thanks for forwarding your receipt. Here's what we found:</p>`,
    `<table cellpadding="0" cellspacing="0" style="margin:12px 0">${rows}</table>`,
  ];

  // Report aggregate: show the report's count + total before and after
  // this receipt was added, so the sender can see at a glance how the
  // report changed.
  if (opts.reportStats) {
    const { before, after } = opts.reportStats;
    blocks.push(
      `<div style="margin:12px 0;padding:12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px">`,
    );
    blocks.push(
      `<p style="margin:0;font-size:13px;color:#166534">` +
        `<b>${escapeHtml(opts.report)}</b>` +
        `<span style="color:#6b7280"> from ${before.count} / $${escapeHtml(before.total)} to ${after.count} / $${escapeHtml(after.total)}</span>` +
        `</p>`,
    );
    blocks.push(`</div>`);
  }

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
    title:
      opts.missing.length > 0
        ? "Receipt imported \u2014 needs attention"
        : "Receipt imported",
    body: blocks.join(""),
    footer: SIMPLE_FOOTER,
  });
}

/**
 * The reply subject: "Receipt accepted: <amount> <category> <report>" —
 * each field only appears when known. Partial imports keep the
 * needs-attention marker.
 */
function confirmationSubject(opts: {
  amount: string;
  category: string;
  report: string;
  missing: string[];
}): string {
  const parts: string[] = [];
  if (opts.amount) parts.push(`$${opts.amount}`);
  if (opts.category) parts.push(opts.category);
  if (opts.report) parts.push(opts.report);
  let subject = "Receipt accepted";
  if (parts.length > 0) subject += `: ${parts.join(" ")}`;
  if (opts.missing.length > 0) subject += " \u2014 needs attention";
  return subject;
}

// --- Pipeline ----------------------------------------------------------------

/**
 * Process one `email.received` webhook. Idempotent per email_id. Returns a
 * ProcessResult for the route to log; failure replies are sent by the
 * pipeline itself.
 */
export async function processInboundEvent(
  data: EmailReceivedData,
  deps: InboundDeps = defaultDeps,
): Promise<ProcessResult> {
  const subject = data.subject ?? "";
  const fromEmail = extractEmailAddress(data.from);

  // Self-reply guard: if the sender is our own inbound address, this is
  // an outbound reply looping back. Skip it without sending another reply
  // (which would itself loop back, creating an infinite chain).
  if (fromEmail === INBOUND_EMAIL_ADDRESS) {
    return { status: "self-reply" };
  }

  // Only VERIFIED sender addresses accept receipts. A sender row that was
  // added but never verified gets a "verify first" reply instead of an
  // import; an address with no row at all is the unknown-sender case.
  const verified = await findVerifiedSenderAccount(fromEmail);
  if (!verified) {
    const pending = await findPendingSenderRow(fromEmail);
    if (pending) {
      await deps.sendReply({
        to: data.from,
        subject: "Receipt not imported — sender not verified yet",
        html: replyHtml("Receipt not imported — verify this address first", [
          `We received your email${subject ? ` “${escapeHtml(subject)}”` : ""} from <b>${escapeHtml(data.from)}</b>, but this address hasn't been verified yet, so receipts from it are not imported.`,
          "Check the inbox of that address for the verification email we sent, or open the app and go to <b>Settings → Receipts by email</b> to resend it. Then forward the receipt again.",
        ]),
        inReplyTo: data.message_id,
        idempotencyKey: data.email_id,
      });
      return { status: "unverified-sender" };
    }
    await deps.sendReply({
      to: data.from,
      subject: "Receipt not imported — sender not recognized",
      html: replyHtml("Receipt not imported", [
        `We received your email${subject ? ` “${escapeHtml(subject)}”` : ""} but the sender address <b>${escapeHtml(data.from)}</b> is not set up to import receipts.`,
        "Open the app, go to <b>Settings → Receipts by email</b>, and add this address to the list of allowed senders. Then forward the receipt again.",
      ]),
      inReplyTo: data.message_id,
      idempotencyKey: data.email_id,
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
        to: data.from,
        subject: "Receipt not imported — something went wrong",
        html: replyHtml("Receipt not imported", paragraphs),
        inReplyTo: data.message_id,
        idempotencyKey: data.email_id,
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
    if (!source) {
      return await fail("No receipt found", [
        `We couldn't find a receipt in the email${subject ? ` “${escapeHtml(subject)}”` : ""} or in any of its attachments.`,
        "Forward the receipt email again, or add the expense manually in the app.",
      ]);
    }

    // Extract receipt data.
    const { categories, merchantCategories, merchantReports, reports } =
      await readExtractionContext(account.id);
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
        buffer,
        mime: contentType || "application/octet-stream",
        categories,
        reports,
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
      extraction = await deps.extractReceipt({
        text: bodyText,
        categories,
        reports,
      });
      if (renderError) {
        console.error("[inbound] email receipt render failed:", renderError);
      }
    }

    // Classify as receipt? If the model says it isn't one and gave nothing
    // usable, don't create an expense.
    const hasUsableData = Boolean(extraction.merchant || extraction.amount);
    if (!extraction.isReceipt && !hasUsableData) {
      return await fail("Not a receipt", [
        `The email${subject ? ` “${escapeHtml(subject)}”` : ""} doesn't look like a receipt, invoice, or order confirmation, so nothing was imported.`,
        "Forward the receipt email again, or add the expense manually in the app.",
      ]);
    }

    // Build the expense (date always comes from the email, never the model).
    const missing: string[] = [];
    if (!expenseDate) missing.push("date");
    if (!extraction.merchant) missing.push("merchant");
    if (!extraction.amount) missing.push("amount");

    let imageFile = "";
    if (receiptImage) {
      const saved = await saveImage(
        account.id,
        receiptImage,
        imageMime,
        originalName,
      );
      imageFile = saved.filename;
      // saveImage may have re-encoded the format (e.g. PNG → JPEG) — record
      // the mime of the bytes actually stored, not the renderer's mime.
      imageMime = saved.mime;
    } else {
      missing.push("receipt image");
    }

    const category = resolveCategory(
      extraction.merchant,
      extraction.category,
      merchantCategories,
      categories,
    );
    const report = resolveReport(
      extraction.merchant,
      extraction.report,
      merchantReports,
      reports,
    );
    if (!category) missing.push("category");

    const now = new Date().toISOString();
    const expense: ReceiptExpense = {
      id: ulid(),
      type: "receipt",
      date: expenseDate,
      report,
      category,
      description: "",
      amount: extraction.amount,
      merchant: extraction.merchant,
      imageFile,
      imageMime,
      originalName,
      reconciledAt: "",
      createdAt: now,
      updatedAt: now,
    };
    await upsertExpense(expense, account.id);

    // Compute report before/after stats when a report is assigned.
    let reportStats:
      | {
          before: { count: number; total: string };
          after: { count: number; total: string };
        }
      | undefined;
    if (report) {
      const summary = await readReportSummary(account.id, report);
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

    if (missing.length > 0) {
      await deps.sendReply({
        to: data.from,
        subject: confirmationSubject({
          amount: extraction.amount,
          category,
          report,
          missing,
        }),
        html: confirmationHtml({
          expenseId: expense.id,
          date: expenseDate,
          merchant: extraction.merchant,
          amount: extraction.amount,
          category,
          report,
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
        }),
        inReplyTo: data.message_id,
        idempotencyKey: data.email_id,
      });
      await upsertInboundEmail({
        emailId: data.email_id,
        accountId: account.id,
        subject,
        status: "partial",
        error: `Missing: ${missing.join(", ")}`,
      });
      return { status: "partial", expenseId: expense.id, missing };
    }

    // Successful import — send a confirmation email with the details.
    await deps.sendReply({
      to: data.from,
      subject: confirmationSubject({
        amount: extraction.amount,
        category,
        report,
        missing: [],
      }),
      html: confirmationHtml({
        expenseId: expense.id,
        date: expenseDate,
        merchant: extraction.merchant,
        amount: extraction.amount,
        category,
        report,
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
      }),
      inReplyTo: data.message_id,
      idempotencyKey: data.email_id,
    });

    await upsertInboundEmail({
      emailId: data.email_id,
      accountId: account.id,
      subject,
      status: "created",
      error: "",
    });
    return { status: "created", expenseId: expense.id };
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

/** True for loopback, private, link-local, and reserved hosts — remote image
 * fetches never target these (guards against SSRF-style probing from email
 * HTML, since the renderer itself never opens a network connection). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h === "::1") return true;
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
    return true; // IPv6 link-local / unique-local
  }
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** Pre-fetch a remote image referenced by the email HTML so it can be
 * inlined as a data URI (the renderer blocks all network). Returns null for
 * anything non-image, oversized, timed out, or pointing at a private host.
 * Redirects are followed manually with the same checks at every hop. */
export async function fetchRemoteImageImpl(
  url: string,
): Promise<CidImage | null> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return null;
  }
  for (let hops = 0; hops <= REMOTE_IMAGE_REDIRECTS; hops += 1) {
    if (
      (current.protocol !== "https:" && current.protocol !== "http:") ||
      isPrivateHost(current.hostname)
    ) {
      return null;
    }
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      try {
        current = new URL(location, current);
      } catch {
        return null;
      }
      continue;
    }
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!/^image\//i.test(type)) return null;
    if (
      Number(res.headers.get("content-length") ?? 0) > REMOTE_IMAGE_MAX_BYTES
    ) {
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > REMOTE_IMAGE_MAX_BYTES) {
      return null;
    }
    return { buffer, mime: type || "image/png" };
  }
  return null;
}
