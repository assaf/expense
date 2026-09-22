/**
 * Build a raw RFC 5322 message for the app's outbound email (replies and
 * verifications). Pure (no I/O), so it is unit-testable and shared by the
 * Fastmail JMAP sender.
 *
 * Structure: multipart/mixed when there are attachments, else
 * multipart/alternative (text + html). An attachment with a `contentId` is
 * shown inline instead: it goes into a multipart/related with the HTML that
 * references it (RFC 2387), nested inside the alternative. All text parts
 * are UTF-8 base64. Header values are RFC 2047-encoded when they contain
 * non-ASCII (emoji subjects like the receipt replies). CRLF line endings
 * throughout.
 */

/** The transport-level input both senders accept (Fastmail JMAP + Resend).
 * Defined here (dependency-free) so fastmail.server and reply.server share
 * one shape instead of each declaring its own. */
export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Original message's id; sets In-Reply-To + References (threading). */
  inReplyTo?: string;
  /** File attachments; `content` is base64. `contentType` overrides the
   * default `application/octet-stream` (images/PDFs get their real type).
   * `contentId` makes the part INLINE: the HTML references it as
   * `cid:<contentId>` (the angle brackets of RFC 2392 are added here) and
   * the client shows it in place of listing it. Only give an id to bytes
   * the HTML actually points at, or the part renders nowhere. */
  attachments?: {
    content: string;
    filename: string;
    contentType?: string;
    contentId?: string;
  }[];
  /** Extra RFC 5322 headers (List-Unsubscribe for marketing email).
   * Names must be printable-ASCII tokens without a colon; values have
   * CR/LF stripped, so neither can inject headers. */
  headers?: Record<string, string>;
}

export interface OutboundMessageInput extends SendEmailInput {
  fromName: string;
  fromEmail: string;
}

const CRLF = "\r\n";

/** RFC 2047-encode a header value when it contains non-ASCII bytes. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Strip CR/LF from a raw header value so a crafted input (e.g. an inbound
 * email's From header, which becomes our reply's To) can't inject extra
 * headers into the outbound message. */
function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function base64Part(lines: string[]): string {
  return wrapBase64(Buffer.from(lines.join(CRLF), "utf8").toString("base64"));
}

/** Wrap a base64 string at 76 chars with CRLF (RFC 2045). */
function wrapBase64(base64: string): string {
  return base64.replace(/(.{76})/g, "$1" + CRLF);
}

function randomBoundary(): string {
  return `exp-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function header(kind: string, value: string): string {
  return `${kind}: ${value}`;
}

/** An attachment on an outbound message. */
type OutboundAttachment = NonNullable<SendEmailInput["attachments"]>[number];

/** One MIME part for an attachment. A `contentId` makes it an INLINE part: it
 * carries the Content-ID that the HTML's `cid:` URL resolves against (RFC
 * 2392) and clients leave it out of the attachment list. Without one it is a
 * plain attachment. */
function attachmentPart(att: OutboundAttachment): string[] {
  // Declared types arrive from inbound parsers; pin the grammar so a
  // future caller can't smuggle CRLF or parameters into the header.
  const contentType = /^([\w.+-]+\/[\w.+-]+)$/.test(att.contentType ?? "")
    ? att.contentType!
    : "application/octet-stream";
  const parts = [
    header(
      "Content-Type",
      `${contentType}; name=${JSON.stringify(att.filename)}`,
    ),
    header(
      "Content-Disposition",
      `${att.contentId ? "inline" : "attachment"}; filename=${JSON.stringify(att.filename)}`,
    ),
  ];
  if (att.contentId) {
    parts.push(header("Content-ID", `<${safeHeaderValue(att.contentId)}>`));
  }
  parts.push("Content-Transfer-Encoding: base64", "", wrapBase64(att.content));
  return parts;
}

/** Build the full RFC 5322 message bytes. */
export function buildRfc822Message(input: OutboundMessageInput): Buffer {
  const boundary = randomBoundary();
  const altBoundary = randomBoundary();
  const relatedBoundary = randomBoundary();
  const messageId = `<exp-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}@fastmail.labnotes.org>`;

  // safeHeaderValue(encodeHeader(...)) at every free-text header: the
  // RFC 2047 encoder passes printable ASCII (including CR/LF) through
  // verbatim, so the strip must wrap it — today's subjects are app-owned,
  // but one interpolated inbound subject away from a header-injection
  // hole (deep-pass INB-HDR-1).
  const from =
    input.fromName.trim() === ""
      ? `<${input.fromEmail}>`
      : `${safeHeaderValue(encodeHeader(input.fromName))} <${input.fromEmail}>`;

  const headers = [
    header("Date", new Date().toUTCString()),
    header("From", from),
    header("To", safeHeaderValue(input.to)),
    header("Subject", safeHeaderValue(encodeHeader(input.subject))),
    header("Message-ID", messageId),
    "MIME-Version: 1.0",
    // Stable marker so the inbound pipelines can recognize this as the
    // app's own outbound mail (confirmation/reply) and never reprocess it
    // (the loop guard). Not subject to subject-wording changes.
    "X-Expense-Confirmation: 1",
  ];
  for (const [kind, value] of Object.entries(input.headers ?? {})) {
    // Header-name injection guard: only RFC 5322 field-name characters.
    if (!/^[A-Za-z0-9-]+$/.test(kind)) continue;
    headers.push(header(kind, safeHeaderValue(value)));
  }
  if (input.inReplyTo) {
    const inReplyTo = safeHeaderValue(input.inReplyTo);
    headers.push(header("In-Reply-To", inReplyTo));
    headers.push(header("References", inReplyTo));
  }

  // Attachments split by how they are presented: an inline part is part of
  // the HTML (referenced by Content-ID), the rest belong to multipart/mixed.
  const attachments = input.attachments ?? [];
  const inline = attachments.filter((att) => att.contentId);
  const files = attachments.filter((att) => !att.contentId);

  // The HTML half of the alternative. Inline images must sit in the SAME
  // multipart/related as the HTML that references them (RFC 2387/2557), with
  // the HTML as the root the `type` names; nesting that inside the
  // alternative is the shape mail clients actually render inline (an image
  // in a sibling mixed part is shown as an attachment instead).
  const htmlPart = inline.length
    ? [
        header(
          "Content-Type",
          `multipart/related; type="text/html"; boundary=${JSON.stringify(relatedBoundary)}`,
        ),
        "",
        "--" + relatedBoundary,
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        base64Part([input.html]),
        ...inline.flatMap((att) => [
          "--" + relatedBoundary,
          ...attachmentPart(att),
        ]),
        "--" + relatedBoundary + "--",
      ]
    : [
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        base64Part([input.html]),
      ];

  const alternative = [
    "--" + altBoundary,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Part([input.text ?? ""]),
    "--" + altBoundary,
    ...htmlPart,
    "--" + altBoundary + "--",
  ];

  const body: string[] = [];
  if (files.length) {
    headers.push(
      header("Content-Type", `multipart/mixed; boundary="${boundary}"`),
    );
    body.push("--" + boundary);
    body.push(
      "Content-Type: multipart/alternative; boundary=" +
        JSON.stringify(altBoundary),
    );
    body.push("");
    body.push(...alternative);
    for (const att of files) {
      body.push("--" + boundary);
      body.push(...attachmentPart(att));
    }
    body.push("--" + boundary + "--");
  } else {
    headers.push(
      header(
        "Content-Type",
        `multipart/alternative; boundary="${altBoundary}"`,
      ),
    );
    body.push(...alternative);
  }

  return Buffer.from([...headers, "", ...body, ""].join(CRLF), "utf8");
}
