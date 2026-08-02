import sharp from "sharp";
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { load } from "cheerio";
import { escapeHtml } from "~/lib/escape";
import { decodeInlineAsset } from "~/lib/inline-asset";
import fontInline from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?inline";

/**
 * Turn an email body into a receipt image (no headless browser needed):
 *  - HTML bodies are reduced to readable text (htmlToText)
 *  - the text is laid out on a white canvas as a monospace "receipt sheet"
 *    and rasterized to PNG — via sharp/librsvg with the font embedded as a
 *    @font-face data URI, falling back to resvg (SVG → PNG) with the
 *    bundled JetBrains Mono woff2 or system fonts.
 *
 * The bundled JetBrains Mono woff2 is embedded in the bundle (Vite ?inline)
 * so rendering works on serverless runtimes that have no system fonts; the
 * fallback chain + ink check guards against runtimes whose font loading is
 * broken (previously these silently produced blank white receipt images).
 */

const FONT_FAMILY = "JetBrains Mono";
const FONT_SIZE = 14;
const LINE_HEIGHT = 22;
const PADDING = 28;
const SVG_WIDTH = 820;
// Monospace advance ≈ 0.6em → ~90 chars fit per line at 14px in 764px.
const CHARS_PER_LINE = 90;

const fontBytes = decodeInlineAsset(fontInline);

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
      `<text x="${PADDING}" y="${y}"${weight}>${escapeHtml(line)}</text>`,
    );
    y += LINE_HEIGHT;
    if (isHeader && i === headerLines.length - 1) y += gap;
  }
  parts.push("</g>", "</svg>");
  return parts.join("");
}

/** The SVG with the bundled font embedded as a data-URI @font-face. */
function embedFontFace(svg: string): string {
  const style = `<style>@font-face{font-family:'${FONT_FAMILY}';src:url(data:font/woff2;base64,${fontBytes.toString("base64")}) format('woff2')}</style>`;
  return svg.replace(/(<svg[^>]*>)/, `$1<defs>${style}</defs>`);
}

/** True when the PNG has any pixel darker than near-white (i.e. real ink). */
export async function hasInk(png: Buffer): Promise<boolean> {
  try {
    const stats = await sharp(png).stats();
    return stats.channels.slice(0, 3).some((c) => c.min < 250);
  } catch {
    // Can't inspect — assume the render is fine rather than degrade it.
    return true;
  }
}

/**
 * Rasterize a text receipt to a PNG buffer (white background, black mono
 * text). Renders through a fallback chain and refuses to return a blank
 * image:
 *  1. sharp (librsvg) with the font embedded via @font-face — sharp is
 *     already used in the receipt pipeline (HEIC/BMP/TIFF → PNG) so its
 *     native binary is guaranteed to be present on every runtime, and the
 *     embedded font needs no runtime font files.
 *  2. resvg with the bundled font (plus system fonts as a safety net).
 *  3. resvg with system fonts only.
 * Each step verifies the output actually contains ink; a silently blank
 * render (e.g. a runtime whose font loading is broken) falls through to the
 * next renderer instead of producing an invisible receipt.
 */
export async function renderReceiptImage(
  text: string,
  opts: { subject?: string } = {},
): Promise<Buffer> {
  const svg = buildReceiptSvg(text, opts);
  const failures: string[] = [];

  try {
    const png = await sharp(Buffer.from(embedFontFace(svg)))
      .png()
      .toBuffer();
    if (await hasInk(png)) return png;
    failures.push("sharp svg render came back blank");
  } catch (err) {
    failures.push(
      `sharp svg render failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // fontBuffers is supported at runtime (resvg fontdb) but not yet in the
  // published type defs — extend the options shape via an intersection.
  type ResvgFontOptions = ResvgRenderOptions["font"] & {
    fontBuffers?: Buffer[];
  };
  const resvgFont = (
    overrides: ResvgFontOptions,
  ): ResvgRenderOptions & { font?: ResvgFontOptions } => ({
    fitTo: { mode: "original" },
    font: { loadSystemFonts: true, ...overrides },
  });

  const resvgAttempts = [
    {
      label: "resvg with bundled font",
      options: resvgFont({
        fontBuffers: [fontBytes],
        defaultFontFamily: FONT_FAMILY,
      }),
    },
    {
      label: "resvg with system fonts",
      options: resvgFont({}),
    },
  ];
  for (const attempt of resvgAttempts) {
    try {
      const png = new Resvg(svg, attempt.options).render().asPng();
      if (await hasInk(png)) return png;
      failures.push(`${attempt.label} came back blank`);
    } catch (err) {
      failures.push(
        `${attempt.label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new Error(
    `Unable to render email receipt image (${failures.join("; ")})`,
  );
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
