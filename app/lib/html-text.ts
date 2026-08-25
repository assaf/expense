import { load } from "cheerio";

/**
 * Reduce an HTML email body to readable plain text. Lives in its own
 * font-free module so importers that only need text extraction (the
 * inbound + connected pipelines) don't pull the resvg font chain, which is
 * heavy (a bundled woff2) and only needed when actually
 * rasterizing a receipt image.
 *
 * Block elements become newlines, inline elements stay inline; scripts,
 * styles, and head/iframe/svg are stripped entirely.
 */
export function htmlToText(html: string): string {
  const $ = load(html);
  $("script, style, noscript, head, iframe, svg, link, meta, form").remove();
  $("br").after("\n");
  $("td, th").each((_, el) => {
    $(el).append("  ");
  });
  $("tr").each((_, el) => {
    $(el).append("\n");
  });
  $(
    "p, div, li, h1, h2, h3, h4, h5, h6, section, article, blockquote, pre, hr, table, ul, ol",
  ).each((_, el) => {
    $(el).append("\n");
  });
  return ($("body").text() || $.root().text() || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
