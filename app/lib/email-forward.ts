import { load } from "cheerio";

/**
 * Forward-block stripping for email bodies — pure text/HTML logic in a
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

/** Remove a forward marker + its trailing header/blank lines from plain
 * text. Returns the text unchanged when no forward block is found. */
export function stripForwardedText(text: string): string {
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

  const kept = [...lines.slice(0, start), ...lines.slice(drop)];
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove a forward marker element + its trailing header/blank sibling
 * elements from HTML. Returns the HTML unchanged when no forward block is
 * found. Uses cheerio so entity decoding and arbitrary element nesting are
 * handled. */
export function stripForwardHeader(html: string): string {
  const $ = load(html);
  const ownText = ($el: ReturnType<typeof $>) => {
    const clone = $el.clone();
    clone.children().remove();
    return clone.text();
  };

  const found: ReturnType<typeof $>[] = [];
  $("*").each((_, el) => {
    const own = ownText($(el));
    if (own && FORWARD_MARKERS.some((m) => m.test(own))) {
      found.push($(el));
    }
  });
  if (found.length === 0) return html;

  for (const $el of found) {
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
    $el.remove();
  }
  return $.html();
}
