import { load } from "cheerio";

/**
 * Forward-block stripping for email bodies: pure text/HTML logic in a
 * font-free module. Lives apart from email-render.server (which pulls the
 * Inter woff2 for the headless-browser render path) so importers that only
 * need to strip forwarded-quote envelopes (the inbound + connected
 * pipelines) don't load the font chain.
 */

/** Forwarded-message markers across common clients. */
export const FORWARD_MARKERS = [
  /-{2,}\s*Original message\s*-{2,}/i, // Fastmail / Apple Mail
  /-{2,}\s*Forwarded message\s*-{2,}/i, // Gmail / Yahoo / Thunderbird
  /Begin forwarded message:?/i, // Apple Mail / iOS
  /Forwarded message:?/i,
];

/** Bound the header-block walk (long To/Cc chains). */
const FORWARD_HEADER_CAP = 15;

const HEADER_LINE_RE =
  /^(From|To|Cc|Bcc|Subject|Date|Sent|Reply-To|Reply To)\s*:/i;

/** True when a line of plain text looks like an email header line. */
function isHeaderLine(line: string): boolean {
  return HEADER_LINE_RE.test(line.trim());
}

/** The words a sender is known by, from `Assaf Arkin <assaf@labnotes.org>`:
 * the display name plus the local part, so a bare address still matches and
 * the domain never does. */
function senderWords(sender?: string): string[] {
  if (!sender) return [];
  const bracket = /<([^>]*)>/.exec(sender);
  const address = bracket ? bracket[1]! : sender;
  const name = bracket ? sender.slice(0, bracket.index) : "";
  return `${name} ${address.split("@")[0] ?? ""}`
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length >= 2);
}

/** Mail clients mark their own signature block: Fastmail wraps it in
 * `id="sig…"` / `class="signature"`, Gmail in `class="gmail_signature"`. */
const SIGNATURE_CLASS_RE = /(^|[\s_-])signature([\s_-]|$)/i;
const SIGNATURE_ID_RE = /^sig([-_]?\d+)?$/i;

/** The same markup as a cheerio selector, for the descendants of a sibling. */
const SIGNATURE_SELECTOR = '[class*="signature" i], [id^="sig" i]';

function looksLikeSignatureMarkup(className: string, id: string): boolean {
  const trimmed = id.trim();
  return (
    SIGNATURE_CLASS_RE.test(className) ||
    SIGNATURE_CLASS_RE.test(trimmed) ||
    SIGNATURE_ID_RE.test(trimmed)
  );
}

/** True when a line is the forwarder's own signature: the RFC 3676 `--`
 * separator, or a dash signature whose first word is one of their own name
 * words (`— Assaf`). An unsigned forward, or one whose sender we cannot
 * name, keeps its preamble: the text above a marker can be the receipt
 * itself when the forward carries no wrapper block. */
function isSignatureLine(line: string, sender?: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "--") return true;
  const match = /^(?:--|[—–-])\s*(.*)$/.exec(trimmed);
  if (!match) return false;
  const rest = (match[1] ?? "").trim();
  // A signature is a line, not a paragraph that happens to start with a dash.
  if (!rest || rest.split(/\s+/).length > 6) return false;
  const words = senderWords(sender);
  if (words.length === 0) return false;
  const first = rest.toLowerCase().split(/[^a-z0-9']+/)[0] ?? "";
  return Boolean(first) && words.includes(first);
}

/** Remove a forward marker, its trailing header/blank lines, and the
 * signature the forwarder's client put directly above the marker from plain
 * text. Returns the text unchanged when no forward block is found. */
export function stripForwardedText(text: string, sender?: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  for (const [i, line] of lines.entries()) {
    if (FORWARD_MARKERS.some((m) => m.test(line.trim()))) {
      start = i;
      break;
    }
  }
  if (start === -1) return text;

  let end = start + 1;
  while (
    end < lines.length &&
    end - start <= FORWARD_HEADER_CAP &&
    (isHeaderLine(lines[end]!) || !lines[end]!.trim())
  ) {
    end += 1;
  }
  // Drop a trailing run of blank lines that separated the header from the
  // actual content.
  let drop = end;
  while (drop > start + 1 && !lines[drop - 1]!.trim()) drop -= 1;

  // The forwarder's own signature sits directly above the marker, put there
  // by their mail client, so it goes with the envelope. Anything else above
  // the marker stays: a forward that carries no wrapper block is a receipt
  // written in the body, and that text is the receipt.
  let prefixEnd = start;
  let above = start - 1;
  while (above >= 0 && !lines[above]!.trim()) above -= 1;
  if (above >= 0 && isSignatureLine(lines[above]!, sender)) prefixEnd = above;

  const kept = [...lines.slice(0, prefixEnd), ...lines.slice(drop)];
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove a forward marker element, its trailing header/blank sibling
 * elements, and the signature block a client put directly above the marker
 * from HTML. Returns the HTML unchanged when no forward block is found. Uses
 * cheerio so entity decoding and arbitrary element nesting are handled. */
export function stripForwardHeader(html: string, sender?: string): string {
  const $ = load(html);

  // Marker elements are read by their *own* text (children removed), so a
  // wrapper that also holds the signature or the original content is not
  // mistaken for the marker line itself.
  const markers = $("*").filter((_, el) => {
    const clone = $(el).clone();
    clone.children().remove();
    const own = clone.text();
    return Boolean(own) && FORWARD_MARKERS.some((m) => m.test(own));
  });
  if (markers.length === 0) return html;

  markers.each((_, el) => {
    const $el = $(el);
    // Remove the header lines that follow the marker as consecutive
    // siblings (blank lines between them are spacer, removed too).
    let sib = $el.next();
    let walked = 0;
    while (sib.length && walked < FORWARD_HEADER_CAP) {
      const t = sib.text().trim();
      if (isHeaderLine(t) || !t) {
        const nxt = sib.next();
        sib.remove();
        sib = nxt;
        walked += 1;
      } else {
        break;
      }
    }

    // The signature the forwarder's client put directly above the marker
    // goes with the envelope: what the marker introduces is the receipt.
    // Blank spacer siblings are collected first and removed only when the
    // block above them turns out to be that signature, so a note the
    // forwarder wrote above the marker is never dropped.
    let spacers = $();
    let prev = $el.prev();
    let back = 0;
    while (prev.length && back < FORWARD_HEADER_CAP) {
      if (!prev.text().trim()) {
        spacers = spacers.add(prev);
        prev = prev.prev();
        back += 1;
        continue;
      }
      const marked =
        looksLikeSignatureMarkup(
          prev.attr("class") ?? "",
          prev.attr("id") ?? "",
        ) || prev.find(SIGNATURE_SELECTOR).length > 0;
      if (marked || isSignatureLine(prev.text(), sender)) {
        prev.remove();
        spacers.remove();
      }
      break;
    }

    $el.remove();
  });
  return $.html();
}
