import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { load } from "cheerio";
import fontInline from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?inline";

/**
 * Turn an email body into a receipt image (no headless browser needed):
 *  - HTML bodies are reduced to readable text (htmlToText)
 *  - the text is laid out on a white canvas as a monospace "receipt sheet"
 *    and rasterized to PNG via resvg (SVG → PNG)
 *
 * The bundled JetBrains Mono woff2 is embedded in the bundle (Vite ?inline)
 * and passed straight to resvg as a font buffer, so rendering works on
 * serverless runtimes that have no system fonts.
 */

const FONT_FAMILY = "JetBrains Mono";
const FONT_SIZE = 14;
const LINE_HEIGHT = 22;
const PADDING = 28;
const SVG_WIDTH = 820;
// Monospace advance ≈ 0.6em → ~90 chars fit per line at 14px in 764px.
const CHARS_PER_LINE = 90;

// Vite `?inline` returns the asset as a base64 string (older versions as a
// `data:` URI) — normalize to raw bytes either way.
const fontBytes = Buffer.from(
  fontInline.includes("base64,") ? fontInline.split("base64,")[1]! : fontInline,
  "base64",
);

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Split text into lines of at most maxChars characters (hard wrap). */
function wrapLines(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/g, "");
    if (line.length <= maxChars) {
      lines.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > maxChars) {
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    lines.push(rest);
  }
  return lines;
}

/**
 * Build the SVG for a text receipt. The subject (if any) is rendered as a
 * bold header line so email receipts are identifiable in the image viewer.
 */
export function buildReceiptSvg(
  text: string,
  opts: { subject?: string } = {},
): string {
  const subject = (opts.subject ?? "").trim();
  const headerLines = subject ? wrapLines(subject, CHARS_PER_LINE) : [];
  const bodyLines = wrapLines(
    text.replace(/\r\n/g, "\n").split("\u0000").join(""),
    CHARS_PER_LINE,
  );
  const lines = headerLines.length
    ? [...headerLines, "", ...bodyLines]
    : bodyLines;
  const gap = headerLines.length ? 12 : 0;
  const height = PADDING * 2 + lines.length * LINE_HEIGHT + gap;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${height}">`,
    `<rect width="${SVG_WIDTH}" height="${height}" fill="#ffffff"/>`,
    `<g font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="#111111">`,
  ];
  let y = PADDING + FONT_SIZE;
  for (const [i, line] of lines.entries()) {
    const isHeader = i < headerLines.length;
    const weight = isHeader ? ' font-weight="700"' : "";
    parts.push(
      `<text x="${PADDING}" y="${y}"${weight}>${escapeXml(line)}</text>`,
    );
    y += LINE_HEIGHT;
    if (isHeader && i === headerLines.length - 1) y += gap;
  }
  parts.push("</g>", "</svg>");
  return parts.join("");
}

/** Rasterize a text receipt to a PNG buffer (white background, black mono text). */
export async function renderReceiptImage(
  text: string,
  opts: { subject?: string } = {},
): Promise<Buffer> {
  const svg = buildReceiptSvg(text, opts);
  // fontBuffers is supported at runtime (resvg fontdb) but not yet in the
  // published type defs — extend the options shape via an intersection.
  const options = {
    fitTo: { mode: "original" },
    font: {
      fontBuffers: [fontBytes],
      defaultFontFamily: FONT_FAMILY,
      loadSystemFonts: false,
    },
  } as ResvgRenderOptions & {
    font?: ResvgRenderOptions["font"] & { fontBuffers?: Buffer[] };
  };
  const resvg = new Resvg(svg, options);
  return resvg.render().asPng();
}

/**
 * Reduce an HTML email body to readable text. Tables keep their cell layout
 * (cells separated by two spaces, rows by newlines); scripts, styles, and
 * embedded SVGs are dropped. Used both for LLM extraction and for rendering
 * the email receipt image.
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
