/**
 * Render an email body into a receipt image using a real browser engine
 * (headless Chromium), so the stored image shows the email as the sender
 * designed it — not a flattened text sheet. Two entry points:
 *  - `renderEmailImage`: render an email's HTML (network blocked, inline
 *    `cid:` images rewritten by the caller-provided resolver).
 *  - `renderTextEmail`: render a plain-text email as a 600px text column
 *    with 24px margins at 14pt.
 *
 * Binary selection:
 *  - Vercel (`process.env.VERCEL === "1"`): `@sparticuz/chromium` — the
 *    packaged Chromium build behind Vercel's own Puppeteer guide. The binary
 *    ships in node_modules (fits the 250MB function limit; supports Node
 *    >=24).
 *  - Local dev/tests: the Playwright Chromium already installed in this repo
 *    (devDependency), driven through puppeteer-core's CDP API so there is a
 *    single code path.
 *  - `RENDER_BROWSER=local|sparticuz|none` overrides the choice; `none`
 *    makes the render throw immediately, to exercise the resvg fallback in
 *    production.
 *
 * Security: the page blocks ALL network requests. Email HTML is untrusted
 * input; nothing may be fetched (no SSRF, no tracking pixels, no slow remote
 * assets). Inline images must be self-contained: either base64 data: URIs
 * (Resend's default `html_format=data_uri`) or `cid:` refs rewritten to
 * data: URIs by the caller-provided resolver.
 */

import type { Browser } from "puppeteer-core";
import puppeteer from "puppeteer-core";
import chromiumSparticuz from "@sparticuz/chromium";
import interWoff2 from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?inline";
import { hasInk } from "~/lib/receipt-render.server";

/** A resolved inline image (cid → data URI payload). */
export interface CidImage {
  buffer: Buffer;
  mime: string;
}

/** Resolve a `cid:` reference from the email's HTML to image bytes. */
export type CidResolver = (cid: string) => Promise<CidImage | null>;

export interface RenderEmailOptions {
  /** Resolve `cid:` image references (inline attachments) to data URIs. */
  resolveImage?: CidResolver;
}

/** Vite `?inline` returns the asset as a base64 string (older versions as a
 * `data:` URI) — normalize to raw bytes either way. */
const fontBytes = Buffer.from(
  interWoff2.includes("base64,") ? interWoff2.split("base64,")[1]! : interWoff2,
  "base64",
);

const HTML_MAX = 4_000_000; // refuse to render absurdly large bodies
const RENDER_TIMEOUT_MS = 10_000;
const PAGE_TIMEOUT_MS = 8_000;
const VIEWPORT_WIDTH = 640; // standard email content width
// Plain-text emails: 600px text column + 24px margins on each side.
const TEXT_VIEWPORT_WIDTH = 648;
const TEXT_COLUMN_MAX = "600px";
const TEXT_MARGIN = 24;
const TEXT_FONT_SIZE = "14pt";

// Email CSS almost always names a system stack (Arial/Helvetica/Verdana/...).
// Serverless runtimes have no system fonts, so shadow those families with
// the bundled Inter — Chromium lets @font-face redefine named families.
const FONT_FAMILIES = [
  "Arial",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Segoe UI",
  "Open Sans",
  "sans-serif",
];

// Receipt/confirmation emails love `<pre>` with long unbroken lines, and
// `pre` refuses to wrap — a 600-char paragraph can inflate the layout to
// thousands of pixels wide (and Puppeteer's fullPage screenshot captures the
// full scroll width). Force wrapping; the clip is a final safety net.
const EMAIL_LAYOUT_CSS =
  "pre{white-space:pre-wrap!important;overflow-wrap:anywhere!important}" +
  "html,body{overflow-x:clip!important}";

interface BrowserConfig {
  executablePath: string;
  args: string[];
  headless: boolean | "shell";
}

async function resolveBrowserConfig(): Promise<BrowserConfig> {
  const override = process.env.RENDER_BROWSER;
  if (override === "none") {
    throw new Error("RENDER_BROWSER=none — Chromium renderer disabled");
  }
  const useSparticuz =
    override === "sparticuz" ||
    (process.env.VERCEL === "1" && override !== "local");
  if (useSparticuz) {
    return {
      executablePath: await chromiumSparticuz.executablePath(),
      args: await puppeteer.defaultArgs({
        args: chromiumSparticuz.args,
        headless: "shell",
      }),
      headless: "shell",
    };
  }
  // Local dev/tests: Playwright's Chromium (installed via `playwright install
  // chromium`). Dynamic import so the prod bundle never touches this dep.
  const { chromium: playwrightChromium } = await import("playwright");
  return {
    executablePath: playwrightChromium.executablePath(),
    args: ["--no-sandbox"],
    headless: true,
  };
}

let browserPromise: Promise<Browser> | null = null;

/** Lazily-launched browser shared across renders; reset on failure so the
 * next call retries (Vercel freezes/thaws instances, so stale handles die). */
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const config = await resolveBrowserConfig();
      return puppeteer.launch({
        args: config.args,
        executablePath: config.executablePath,
        headless: config.headless,
      });
    })();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

/** Embed the bundled font as @font-face aliases for common email families. */
function injectStyles(html: string, styles: string[]): string {
  const style = `<style>${styles.join("")}</style>`;
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}${style}`);
  const body = html.match(/<body[^>]*>/i);
  if (body) return html.replace(body[0], `${body[0]}${style}`);
  return `${style}${html}`;
}

/** The bundled-font CSS: aliases common email families to Inter. */
function fontStyle(): string {
  return [
    ...FONT_FAMILIES.map(
      (family) =>
        `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${fontBytes.toString("base64")}) format('woff2');font-weight:100 900;font-style:normal}`,
    ),
    "html,body{font-family:Arial,Helvetica,sans-serif}",
  ].join("");
}

/** Embed the bundled font into an email/text document. */
function injectFonts(html: string): string {
  return injectStyles(html, [fontStyle()]);
}

/** Rewrite `cid:` references (src/srcset/url()) to data: URIs via the
 * resolver; unresolvable refs are left for the browser to drop. */
async function rewriteCidImages(
  html: string,
  resolveImage: CidResolver | undefined,
): Promise<string> {
  if (!resolveImage) return html;
  const cids = [
    ...new Set([...html.matchAll(/cid:([^"'\s)<>]+)/g)].map((m) => m[1]!)),
  ];
  const resolved = new Map<string, CidImage>();
  for (const cid of cids) {
    const image = await resolveImage(cid).catch(() => null);
    if (image) resolved.set(cid, image);
  }
  if (resolved.size === 0) return html;
  let out = html;
  for (const [cid, image] of resolved) {
    const uri = `data:${image.mime};base64,${image.buffer.toString("base64")}`;
    out = out.split(`cid:${cid}`).join(uri);
  }
  return out;
}

/**
 * Render a document to a full-page PNG with the shared Chromium setup:
 * network blocked, bundled fonts, blank-output check, hard timeout. The
 * page is closed on every path.
 */
async function renderDocument(
  doc: string,
  viewportWidth: number,
): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let timer: NodeJS.Timeout | undefined;
  try {
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await page.setViewport({ width: viewportWidth, height: 800 });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        void request.abort();
      } else {
        void request.continue();
      }
    });
    const render = async (): Promise<Uint8Array> => {
      await page.setContent(doc, { waitUntil: "load" });
      // Capture the content at the fixed viewport width using the measured
      // height — NOT fullPage, which would grow the capture to the full
      // scroll width (a wide email element would produce a huge blank
      // strip). Content beyond the cap is clipped, like an email client.
      const height = await page.evaluate(() =>
        Math.min(document.documentElement.scrollHeight, 20_000),
      );
      await page.setViewport({ width: viewportWidth, height });
      return page.screenshot({ type: "png" });
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Render timed out")),
        RENDER_TIMEOUT_MS,
      );
    });
    const png = Buffer.from(await Promise.race([render(), timeout]));
    if (!(await hasInk(png))) {
      throw new Error("Chromium render came back blank");
    }
    return png;
  } finally {
    clearTimeout(timer);
    await page.close();
  }
}

/**
 * Render an email's HTML to a full-page PNG (white background, network
 * blocked, bundled fonts). Throws on empty/oversized input, blank output,
 * or browser failure — callers fall back to the resvg text sheet.
 */
export async function renderEmailImage(
  html: string,
  opts: RenderEmailOptions = {},
): Promise<Buffer> {
  const trimmed = html.trim();
  if (!trimmed) throw new Error("Empty HTML body");
  if (trimmed.length > HTML_MAX) {
    throw new Error("HTML body too large to render");
  }
  // Email HTML often arrives as a fragment; without a doctype Chromium
  // renders in quirks mode, which inflates percentage table widths. Force
  // standards mode, then clamp pre-wrapping so long lines can't widen the
  // layout (see EMAIL_LAYOUT_CSS).
  const doctype = /<!doctype/i.test(trimmed) ? "" : "<!doctype html>";
  const body = await rewriteCidImages(trimmed, opts.resolveImage);
  const doc = injectStyles(`${doctype}${body}`, [
    fontStyle(),
    EMAIL_LAYOUT_CSS,
  ]);
  return renderDocument(doc, VIEWPORT_WIDTH);
}

export interface RenderTextEmailOptions {
  /** Show the sender line in a small envelope bar (e.g. "Jane <j@x.com>"). */
  from?: string;
  /** Show the subject line in a small envelope bar. */
  subject?: string;
}

/**
 * Render a plain-text email to a full-page PNG: a 600px text column with
 * 24px margins and 14pt sans-serif text, so the body reads like an email
 * rather than a wide mono sheet. Throws on empty/oversized input, blank
 * output, or browser failure — callers fall back to the resvg text sheet.
 */
export async function renderTextEmail(
  text: string,
  opts: RenderTextEmailOptions = {},
): Promise<Buffer> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Empty text body");
  if (trimmed.length > HTML_MAX) {
    throw new Error("Text body too large to render");
  }
  return renderDocument(
    injectFonts(buildTextDocument(trimmed, opts)),
    TEXT_VIEWPORT_WIDTH,
  );
}

/** Escape HTML-significant characters for the text document. */
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildTextDocument(text: string, opts: RenderTextEmailOptions): string {
  const envelope =
    opts.from || opts.subject
      ? `<div style="background-color:#f8fafc;border-bottom:1px solid #e2e8f0;padding:10px 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#475569">` +
        (opts.from ? `<div><b>From:</b> ${escapeText(opts.from)}</div>` : "") +
        (opts.subject
          ? `<div><b>Subject:</b> ${escapeText(opts.subject)}</div>`
          : "") +
        `</div>`
      : "";
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:${TEXT_FONT_SIZE};line-height:1.55;color:#1f2937">
  <div style="max-width:${TEXT_COLUMN_MAX};margin:${TEXT_MARGIN}px auto;padding:0">
    ${envelope}
    <div style="white-space:pre-wrap;overflow-wrap:anywhere;padding:24px">${escapeText(text)}</div>
  </div>
</body></html>`;
}
