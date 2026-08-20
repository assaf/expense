/**
 * Build a raw RFC 5322 message for the app's outbound email (replies and
 * verifications). Pure — no I/O — so it is unit-testable and shared by the
 * FastMail JMAP sender.
 *
 * Structure: multipart/mixed when there are attachments, else
 * multipart/alternative (text + html). All text parts are UTF-8 base64.
 * Header values are RFC 2047-encoded when they contain non-ASCII (emoji
 * subjects like the receipt replies). CRLF line endings throughout.
 */

/** The transport-level input both senders accept (FastMail JMAP + Resend).
 * Defined here (dependency-free) so fastmail.server and reply.server share
 * one shape instead of each declaring its own. */
export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Original message's id — sets In-Reply-To + References (threading). */
  inReplyTo?: string;
  /** File attachments; `content` is base64. */
  attachments?: { content: string; filename: string }[];
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

/** Build the full RFC 5322 message bytes. */
export function buildRfc822Message(input: OutboundMessageInput): Buffer {
  const boundary = randomBoundary();
  const altBoundary = randomBoundary();
  const messageId = `<exp-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}@fastmail.labnotes.org>`;

  const from =
    input.fromName.trim() === ""
      ? `<${input.fromEmail}>`
      : `${encodeHeader(input.fromName)} <${input.fromEmail}>`;

  const headers = [
    header("Date", new Date().toUTCString()),
    header("From", from),
    header("To", input.to),
    header("Subject", encodeHeader(input.subject)),
    header("Message-ID", messageId),
    "MIME-Version: 1.0",
    // Stable marker so the inbound pipelines can recognize this as the
    // app's own outbound mail (confirmation/reply) and never reprocess it
    // — the loop guard. Not subject to subject-wording changes.
    "X-Expense-Confirmation: 1",
  ];
  if (input.inReplyTo) {
    headers.push(header("In-Reply-To", input.inReplyTo));
    headers.push(header("References", input.inReplyTo));
  }

  const alternative = [
    "--" + altBoundary,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Part([input.text ?? ""]),
    "--" + altBoundary,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Part([input.html]),
    "--" + altBoundary + "--",
  ];

  const body: string[] = [];
  if (input.attachments?.length) {
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
    for (const att of input.attachments) {
      body.push("--" + boundary);
      body.push(
        header(
          "Content-Type",
          `application/octet-stream; name=${JSON.stringify(att.filename)}`,
        ),
      );
      body.push(
        header(
          "Content-Disposition",
          `attachment; filename=${JSON.stringify(att.filename)}`,
        ),
      );
      body.push("Content-Transfer-Encoding: base64");
      body.push("");
      body.push(wrapBase64(att.content));
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
