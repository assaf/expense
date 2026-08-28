import {
  FORWARD_MARKERS,
  stripForwardedText,
  stripForwardHeader,
} from "~/lib/email-forward";
import type {
  CidImage,
  CidResolver,
  RenderEmailOptions,
  RenderTextEmailOptions,
} from "~/lib/email-render.server";
import { htmlToText } from "~/lib/html-text";
import { fetchPublicUrl, readBodyLimited } from "~/lib/ssrf.server";
import { detectImageMime, isImage, isPdf } from "~/lib/file-types";
import {
  composeLocalDescription,
  resolveExtraction,
  tryKnownMerchantExtraction,
  tryLocalExtraction,
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
import { captureWarning } from "~/lib/errors.server";
import { escapeHtml } from "~/lib/escape";
import {
  confirmationEmail,
  confirmationNotes,
} from "~/lib/email-confirmation.server";
import { domainOf, extractEmailAddress } from "~/lib/validation";
import type { SendEmailOptions } from "~/lib/reply.server";
import {
  upsertExpense,
  findRecentlyImportedMatch,
  findSameImageExpense,
} from "~/lib/db/expenses";
import { readExtractionContext } from "~/lib/db/extraction-context";
import {
  findPendingSenderRow,
  findVerifiedSenderAccount,
  upsertInboundEmail,
  claimInboundEmail,
} from "~/lib/db/inbound";
import { addEmailRule } from "~/lib/db/email-rules";
import { readReportSummary } from "~/lib/db/reports";
import { saveImage, readImage, deleteImage } from "~/lib/images.server";
import { INBOUND_EMAIL_ADDRESS } from "~/lib/env";
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
 * the receipt image, and creates the expense, scoped to the account whose
 * VERIFIED inbound sender matches the From address (an added-but-unverified
 * address gets a "verify first" reply and no import).
 *
 * Replies: failures and incomplete imports get an explanatory email;
 * successful imports get a confirmation with the extracted details and the
 * ORIGINAL receipt: the body text quoted below the details, or the
 * original image/PDF attached (`confirmationEmail`, `saveExpenseFromExtraction`).
 * Each email id (the JMAP id) is tracked in `inbound_emails` so a
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
  /** Parsed headers (lowercased keys not guaranteed; use
   * hasOwnConfirmationHeader for case-insensitive lookup). Lets the
   * pipeline recognize the app's own outbound mail (loop guard). */
  headers: Record<string, string>;
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
  | { status: "concurrent" }
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
   * throw, so the pipeline treats replies as fire-and-forget. */
  sendReply(input: SendEmailOptions): Promise<void>;
}

// --- Date -------------------------------------------------------------------

/** Named-zone offsets V8 parses in Date strings (US zones; V8 knows these
 * abbreviations but not their UTC offsets). Hours east of UTC. */
const NAMED_ZONE_OFFSET_HOURS: Record<string, number> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  EST: -5,
  EDT: -4,
  CST: -6,
  CDT: -5,
  MST: -7,
  MDT: -6,
  PST: -8,
  PDT: -7,
};

/** The UTC offset the date string itself names, in ms: an RFC 2822/ISO
 * numeric zone ("-0700", "+05:30"), "Z"/"z", or a named US zone ("PDT").
 * Null when the string carries no explicit zone (naive). */
function zoneOffsetMs(s: string): number | null {
  const numeric = s.match(/([+-]\d{2}:?\d{2}|Z|z)\s*(?:\([^)]*\))?\s*$/);
  if (numeric) {
    const zone = numeric[1]!;
    if (zone === "Z" || zone === "z") return 0;
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.replace(/\D/g, "").padEnd(4, "0");
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2, 4));
    return sign * (hours * 60 + minutes) * 60_000;
  }
  const named = s.match(
    /\b(UT|UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b\s*$/i,
  );
  if (named) {
    const key = named[1]!.toUpperCase();
    return NAMED_ZONE_OFFSET_HOURS[key]! * 3_600_000;
  }
  return null;
}

/**
 * Parse an RFC 2822 / human date string into YYYY-MM-DD, in the timezone the
 * string itself names (the sender's local date, which is what a receipt
 * means). The UTC calendar date of the same instant can be the next (or
 * previous) day for evening sends in negative offsets (17:08 PDT on Aug 23
 * is 00:08 UTC Aug 24). Naive strings (no zone) keep the UTC interpretation.
 * Null if invalid or in the future.
 */
export function parseDateString(s: string): string | null {
  let clean = s.trim();
  if (!clean) return null;
  // Gmail-style human dates use "at": "Tue, Jun 2, 2026 at 3:14 PM".
  clean = clean.replace(/\s+at\s+/gi, ", ");
  const t = Date.parse(clean);
  if (!Number.isFinite(t)) return null;
  if (t > Date.now() + 24 * 3600 * 1000) return null; // future → invalid
  return new Date(t + (zoneOffsetMs(clean) ?? 0)).toISOString().slice(0, 10);
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

/** Download a small .eml attachment (the embedded original message) as
 * UTF-8 text. Null when there is none, it is empty, or it is >= 1 MB;
 * beyond that it is not worth parsing for quoted headers. The text is
 * capped at 100k chars; the headers the callers want live at the top.
 * Shared by the bounce reader, the receipt-date reader, and the
 * forwarded-sender reader. */
async function readSmallEmlAttachment(
  attachments: AttachmentMeta[],
  deps: Pick<InboundDeps, "downloadAttachment">,
): Promise<string | null> {
  const eml = attachments.find(isEmlMeta);
  if (!eml || eml.size === 0 || (eml.size ?? Infinity) >= 1_000_000) {
    return null;
  }
  return (await deps.downloadAttachment(eml))
    .toString("utf8")
    .slice(0, 100_000);
}

/**
 * Heuristic score: PDFs and images are candidates; logos/signatures (tiny,
 * inline, or named) are penalized; inline images referenced by the HTML
 * (`cid:` in an <img>) are boosted, because that is often the receipt itself.
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

/** The content type to declare for the reply's original-receipt attachment:
 * sniffed from the bytes first (the declared type can be a bogus
 * application/octet-stream for a screenshot), the declared media type
 * otherwise. */
function replyAttachmentContentType(buffer: Buffer, declared: string): string {
  if (isPdf({ buffer })) return "application/pdf";
  const sniffed = detectImageMime(buffer);
  if (sniffed) return sniffed;
  return /^(image\/|application\/pdf)/i.test(declared)
    ? declared
    : "application/octet-stream";
}

/** The stored receipt image as a base64 attachment (the connected
 * pipeline's owner-inbox confirmation). undefined when the import produced
 * no stored image. */
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

// --- Bounce / auto-reply detection ------------------------------------------
//
// Delivery-status notifications (bounces) arrive when one of OUR outbound
// replies fails. Without a guard, a bounce looks like an unknown sender and
// gets a "sender not recognized" reply, which itself bounces, which gets
// another reply, looping forever and filling the Sent folder. Autoresponders
// (vacation notices, delivery receipts) are the same trap: they reply to
// every message, so replying to them is also an infinite loop.
//
// Two layers: a cheap check on metadata that exists before any fetch (DSN
// subject lines and daemon senders, which catches Fastmail's own bounces),
// and a header check after fetch (null Return-Path, multipart/report,
// Auto-Submitted), which catches DSNs that arrive with a spoofed From and
// autoresponder loops).

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
 * appear bare, in angle brackets, or after a display name; captures are
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
 * original message. Null when the bounce names no address (the caller
 * still drops the bounce either way; this is only for the log).
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
  try {
    const text = await readSmallEmlAttachment(attachments, deps);
    if (text) {
      const to = /^[ \t]*To:[ \t]*(.+)$/im.exec(text);
      if (to) {
        const addr = /<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/i.exec(
          to[1]!,
        );
        if (addr) return cleanBounceAddress(addr[1]!);
      }
    }
  } catch {
    // Best effort: a broken attachment must not fail the drain.
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
  const emlText = await readSmallEmlAttachment(attachments, deps);
  const emlMatch = emlText?.match(FORWARD_FROM_RE);
  if (emlMatch) return domainOf(emlMatch[1]!);
  const body = email.text || htmlToText(email.html ?? "");
  const bodyMatch = body.match(FORWARD_FROM_RE);
  if (bodyMatch) return domainOf(bodyMatch[1]!);
  return null;
}

/** Learn a user rule from a successfully imported forward (best effort;
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
// middle (pick the receipt source, extract, render, save the expense)
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
  const expenseDate = extractExpenseDate(
    email,
    (await readSmallEmlAttachment(attachments, deps)) ?? undefined,
  );

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
    // Metadata scoring missed every attachment (e.g. a phone screenshot
    // served as application/octet-stream with a UUID filename and no
    // extension). Sniff the best unscored candidate before falling back to
    // the body: prefer an attachment-disposition part, largest first. At
    // most one download; if it isn't an image/PDF by magic bytes, the
    // body path below decides.
    const unscored = attachments
      .filter((meta) => !isPdfMeta(meta) && !isImageMeta(meta))
      .sort(
        (a, b) =>
          Number(b.content_disposition?.toLowerCase() === "attachment") -
            Number(a.content_disposition?.toLowerCase() === "attachment") ||
          (b.size ?? 0) - (a.size ?? 0),
      );
    const candidate = unscored[0];
    if (candidate && (candidate.size ?? 0) > 0) {
      const buffer = await deps.downloadAttachment(candidate);
      if (isPdf({ buffer }) || isImage({ buffer })) {
        source = {
          kind: "attachment",
          buffer,
          contentType: candidate.content_type ?? "",
          filename: candidate.filename,
        };
      }
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
  /** Connected-mailbox flow: extract with local logic only (no model
   * call). Body receipts parse via the known-merchant or rule-merchant
   * path; attachment receipts return null (skip for manual review). */
  localOnly?: boolean;
  /** Review mode: the user explicitly picked this email, so usable data
   * imports even when the extractor wouldn't call it a receipt. The auto
   * drains (review unset) require isReceipt — a body amount alone never
   * promotes non-receipt mail into an expense. */
  review?: boolean;
  /** The matched rule's sender domain, used to name a first-time merchant
   * when localOnly is set. Required for the rule-merchant local path. */
  ruleSender?: string;
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
    if (opts.localOnly) {
      // No model: PDFs with a text layer are extracted locally (pdf.js,
      // no OCR, no vision). Image attachments + scanned PDFs (no text
      // layer) are skipped: they need OCR/vision, and the connected flow
      // is LLM-free. The email stays in the Inbox for a manual add.
      if (!isPdf({ mime: contentType, originalName: filename })) return null;
      const { extractPdfText, renderPdfToPng } =
        await import("~/lib/receipt-ocr.server");
      const pdfText = await extractPdfText(buffer);
      // Text layer must exist; scanned PDFs are skipped (they need OCR).
      const local =
        pdfText.trim().length >= 20
          ? tryLocalExtraction(
              pdfText,
              email.subject,
              context.knownMerchants,
              opts.ruleSender,
            )
          : null;
      if (!local) return null; // no text layer, or no parseable total
      extraction = local;
      // Rasterize the ACTUAL PDF pages to a PNG (pdf.js, no Chromium, no
      // model) so the receipt image shows the real layout, not a flattened
      // text sheet.
      try {
        receiptImage = await renderPdfToPng(buffer);
      } catch (err) {
        renderError = err instanceof Error ? err.message : String(err);
      }
      imageMime = "image/png";
      originalName = filename.replace(/\.pdf$/i, ".png");
    } else {
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
    }
  } else {
    const bodyText = stripForwardedText(source.text).slice(0, 20_000);
    // Render the actual email with headless Chromium: the HTML part when
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
    if (opts.localOnly) {
      // No model: prefer a known merchant (repeat), else the rule sender.
      // Null when no total parses locally -> caller skips (stays in Inbox).
      const local = tryLocalExtraction(
        bodyText,
        email.subject,
        context.knownMerchants,
        opts.ruleSender,
      );
      if (!local) return null;
      extraction = local;
    } else {
      // Known-merchant skip: the body names a merchant the account has spent
      // with before and carries a parseable total, so no model call is needed.
      // The description is composed locally too (bill ref, billed account,
      // Apple plan name); the skip must not lose the receipt's own context.
      const skipped = tryKnownMerchantExtraction(
        bodyText,
        context.knownMerchants,
      );
      extraction = skipped
        ? {
            ...skipped,
            description: composeLocalDescription(email.subject, bodyText),
          }
        : await deps.extractReceipt({
            accountId: opts.accountId,
            text: bodyText,
            categories: context.categories,
            reports: context.reports,
          });
    }
    if (renderError) {
      console.error("[inbound] email receipt render failed:", renderError);
    }
  }

  // Classify as receipt? The auto drains require the extractor's
  // isReceipt verdict — a body amount alone never promotes non-receipt
  // mail (bank alerts, newsletters) into an expense. Review mode keeps
  // the looser gate: the user explicitly picked the email.
  if (opts.review) {
    const hasUsableData = Boolean(extraction.merchant || extraction.amount);
    if (!extraction.isReceipt && !hasUsableData) {
      return null;
    }
  } else if (!extraction.isReceipt) {
    return null;
  }
  return { extraction, receiptImage, imageMime, originalName, renderError };
}

/** Before/after report stats for the confirmation email. */
interface ReportSummaryStats {
  before: { count: number; total: string };
  after: { count: number; total: string };
}

/** A saved expense plus everything its confirmation email needs.
 *
 * The confirmation has two audiences with different receipts:
 * - The SENDER's reply always carries the ORIGINAL receipt: the original
 *   file (`originalAttachment`, image/PDF source) or the original body
 *   text (`quotedOriginal`, body source). Never the stored processed image.
 * - The connected pipeline's owner-inbox confirmation carries the STORED
 *   image (`receiptAttachment`), because the original email is already in
 *   the owner's Inbox and would be redundant there. */
interface SavedExpense {
  expenseId: string;
  missing: string[];
  category: string;
  report: string;
  reportStats?: ReportSummaryStats;
  /** The original receipt file (image/PDF attachment source) to attach to
   * the sender's confirmation reply; it is the sender's file, not the rendered
   * image. */
  originalAttachment?: {
    content: string;
    filename: string;
    contentType?: string;
  };
  /** The original email body text (body source) to quote in the sender's
   * confirmation reply. */
  quotedOriginal?: string;
  /** The stored receipt image as an attachment (connected pipeline's
   * owner-inbox confirmation only). */
  receiptAttachment?: { content: string; filename: string };
  /** A matching receipt was imported within the recent window (the other
   * pipeline), so suppress this confirmation to avoid duplicate responses. */
  recentMatch?: { id: string; createdAt: string };
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
  /** What the receipt was in the incoming email; the reply carries the
   * original: quoted text for a body source, the original file for an
   * attachment source. */
  originalSource: ReceiptSource;
}): Promise<SavedExpense | { duplicateOf: string }> {
  const { extraction, receiptImage } = opts;
  const missing: string[] = [];
  if (!opts.expenseDate) missing.push("date");
  if (!extraction.merchant) missing.push("merchant");
  if (!extraction.amount) missing.push("amount");

  let imageFile = "";
  let imageMime = opts.imageMime;
  let imageSha256 = "";
  if (receiptImage) {
    const saved = await saveImage(
      opts.accountId,
      receiptImage,
      imageMime,
      opts.originalName,
    );
    imageFile = saved.filename;
    // saveImage may have re-encoded the format (e.g. PNG → JPEG), so record
    // the mime of the bytes actually stored, not the renderer's mime.
    imageMime = saved.mime;
    imageSha256 = saved.sha256;
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
    imageSha256,
  };
  // The exact same image bytes already belong to an expense: importing
  // again would duplicate it, whatever the extracted fields say. The
  // just-stored blob is dropped (the first copy stays with its expense);
  // the caller decides the outcome (auto paths skip, review keeps the
  // item listed).
  const sameImage = await findSameImageExpense(opts.accountId, imageSha256);
  if (sameImage) {
    await deleteImage(opts.accountId, imageFile);
    return { duplicateOf: sameImage.id };
  }
  await upsertExpense(expense, opts.accountId);

  // The sender's reply carries the ORIGINAL receipt, never the stored
  // processed image: the original file for an attachment source, the
  // original body text for a body source. (The stored-image attachment
  // above exists only for the connected pipeline's owner-inbox
  // confirmation, where the original email is already in the Inbox.)
  const receiptAttachment = await receiptImageAttachment(
    opts.accountId,
    imageFile,
  );
  let originalAttachment: SavedExpense["originalAttachment"];
  let quotedOriginal: SavedExpense["quotedOriginal"];
  if (opts.originalSource.kind === "attachment") {
    const { buffer, contentType, filename } = opts.originalSource;
    originalAttachment = {
      content: buffer.toString("base64"),
      filename,
      contentType: replyAttachmentContentType(buffer, contentType),
    };
  } else {
    quotedOriginal = opts.originalSource.text;
  }

  // The same receipt already imported within the recent window. The
  // connected-account pipeline imported the inbox original moments ago and
  // this import is the user's forwarded copy (or vice versa). The caller
  // suppresses its confirmation so the user gets one response per receipt.
  const recentMatch = await findRecentlyImportedMatch(opts.accountId, {
    merchant: expense.merchant,
    amount: expense.amount,
    date: expense.date,
    description: expense.description,
    excludeExpenseId: expense.id,
  });

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
    originalAttachment,
    quotedOriginal,
    receiptAttachment,
    recentMatch,
  };
}

/**
 * Send the confirmation, or suppress it when the same receipt was already
 * imported within the recent window by the other pipeline (the inbox
 * original vs. the forwarded copy). The user gets one response per receipt;
 * the suppression is logged and Sentry-alerted so a false match (two
 * genuinely different receipts with the same merchant/amount/date and no
 * description) is visible instead of silent.
 */
async function sendConfirmationOrSuppress(opts: {
  deps: InboundDeps;
  data: EmailReceivedData;
  confirmation: { subject: string; html: string; text: string };
  /** The original receipt file (image/PDF source), attached instead of
   * the stored rendered image. */
  originalAttachment?: {
    content: string;
    filename: string;
    contentType?: string;
  };
  recentMatch?: { id: string; createdAt: string };
}): Promise<void> {
  if (opts.recentMatch) {
    console.info(
      "[inbound] confirmation suppressed — same receipt imported recently",
      {
        emailId: opts.data.email_id,
        to: opts.data.from,
        subject: opts.confirmation.subject,
        matchedExpenseId: opts.recentMatch.id,
        matchedAt: opts.recentMatch.createdAt,
      },
    );
    captureWarning(
      "[inbound] duplicate confirmation suppressed — same receipt imported recently",
      {
        emailId: opts.data.email_id,
        to: opts.data.from,
        subject: opts.confirmation.subject,
        matchedExpenseId: opts.recentMatch.id,
      },
    );
    return;
  }
  await opts.deps.sendReply({
    ...replyEnvelope(opts.data),
    subject: opts.confirmation.subject,
    html: opts.confirmation.html,
    text: opts.confirmation.text,
    attachments: opts.originalAttachment
      ? [opts.originalAttachment]
      : undefined,
  });
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
  // failed. Never import it and never answer it: replying to a bounce (or
  // to an autoresponder) starts a reply→bounce→reply loop that fills Sent.
  // This check runs before the sender resolution so Fastmail's own
  // MAILER-DAEMON bounces never reach the "unknown sender" reply path.
  if (looksLikeBounce(data)) {
    // Never import and never answer a bounce, but name the failed recipient
    // for the log (best effort; fetch/extraction failures still drop it).
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
          "Check the inbox of that address for the verification email we sent, or open the app and go to <b>Email → Receipts by email</b> to resend it. Then forward the receipt again.",
        ]),
      });
      return { status: "unverified-sender" };
    }
    // Unknown senders get NO reply: the From header is attacker-controlled at
    // SMTP time, so replying would let anyone use the app's mailbox as an
    // unauthenticated mail amplifier against arbitrary addresses. Log the
    // drop and move on; the owner sees nothing and the sender learns
    // nothing (verification flow exists for addresses the owner adds).
    console.info("[inbound] dropped mail from unrecognized sender", {
      emailId: data.email_id,
      from: data.from,
      subject,
    });
    return { status: "unknown-sender" };
  }
  const account = verified.account;

  // Atomic claim: exactly one drain owns this email. A burst of webhook
  // pushes (or a push racing the daily cron) can both list the same email
  // before either marks it `$receipt-processed`; the first to insert the
  // "processing" row wins, and every other drain skips without importing
  // or replying; otherwise the same receipt gets two confirmations (and
  // two import attempts).
  const claim = await claimInboundEmail({
    emailId: data.email_id,
    accountId: account.id,
    subject,
  });
  if (!claim.claimed) {
    const existing = claim.existing;
    if (existing?.status === "created" || existing?.status === "partial") {
      return { status: "duplicate" };
    }
    if (existing?.status === "processing") {
      // Another drain is importing this email right now. It sends the
      // confirmation. Never import twice, never reply twice.
      return { status: "concurrent" };
    }
    // "error" (or a vanished row): a previous run already failed and
    // emailed the sender. The reply is the recovery path, so re-running
    // the pipeline here would only re-send a second error email.
    return { status: "duplicate" };
  }

  const fail = async (
    error: string,
    paragraphs: string[],
  ): Promise<ProcessResult> => {
    await deps.sendReply({
      ...replyEnvelope(data),
      subject: "⚠️ Receipt not imported — something went wrong",
      html: replyHtml("Receipt not imported", paragraphs),
    });
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
      originalSource: selected.source,
    });
    if ("duplicateOf" in saved) {
      // The same receipt image was already imported (any route): no second
      // expense, no confirmation. The email is destroyed like every other
      // decided outcome, so re-forwarding can't loop.
      return { status: "duplicate" };
    }
    const { missing, category, report } = saved;
    const expenseDate = selected.expenseDate;
    const extraction = extracted.extraction;
    const renderError = extracted.renderError;
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
        notes: confirmationNotes({
          notes: extraction.notes,
          currency: extraction.currency,
          renderError,
        }),
        missing,
        reportStats,
        quotedOriginal: saved.quotedOriginal,
      });
      await sendConfirmationOrSuppress({
        deps,
        data,
        confirmation,
        originalAttachment: saved.originalAttachment,
        recentMatch: saved.recentMatch,
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

    // Successful import: send a confirmation email with the details.
    const confirmation = confirmationEmail({
      expenseId,
      date: expenseDate,
      merchant: extraction.merchant,
      amount: extraction.amount,
      category,
      report,
      description: extraction.description,
      notes: confirmationNotes({
        notes: extraction.notes,
        currency: extraction.currency,
      }),
      missing: [],
      reportStats,
      quotedOriginal: saved.quotedOriginal,
    });
    await sendConfirmationOrSuppress({
      deps,
      data,
      confirmation,
      originalAttachment: saved.originalAttachment,
      recentMatch: saved.recentMatch,
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
 * hosts rejected, redirects re-checked at every hop; see ssrf.server). */
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
  // Stream with a hard cap: the cap must hold DURING the read, not after
  // arrayBuffer() has already committed the full body (readBodyLimited
  // cancels the stream past the limit). A slow-dripping or chunked server
  // response can't force unbounded buffering.
  const buffer = await readBodyLimited(res, REMOTE_IMAGE_MAX_BYTES).catch(
    () => null,
  );
  if (!buffer || buffer.length === 0) {
    return null;
  }
  return { buffer, mime: type || "image/png" };
}
