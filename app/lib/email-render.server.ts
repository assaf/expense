/**
 * Render an email's HTML body into a receipt image using a real browser
 * engine (headless Chromium), so the stored image shows the email as the
 * sender designed it — not a flattened text sheet.
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

// Email CSS almost always names a system stack (Arial/Helvetica/Verdana/...).
// Serverless runtimes have no system fonts, so shadow those families with
// the bundled Inter — Chromium lets @font-face redefine named families.
const FONT_FAMILIES = [
  "Arial",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Segoe UI",
  "sans-serif",
];

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
function injectFonts(html: string): string {
  const fontCss = [
    ...FONT_FAMILIES.map(
      (family) =>
        `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${fontBytes.toString("base64")}) format('woff2');font-weight:100 900;font-style:normal}`,
    ),
    "html,body{font-family:Arial,Helvetica,sans-serif}",
  ].join("");
  const style = `<style>${fontCss}</style>`;
  const head = html.match(/<head[^>]*>/i);
  return head ? html.replace(head[0], `${head[0]}${style}`) : `${style}${html}`;
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

  const doc = injectFonts(await rewriteCidImages(trimmed, opts.resolveImage));

  const browser = await getBrowser();
  const page = await browser.newPage();
  let timer: NodeJS.Timeout | undefined;
  try {
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await page.setViewport({ width: VIEWPORT_WIDTH, height: 800 });
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
      return page.screenshot({ fullPage: true, type: "png" });
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Email render timed out")),
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
