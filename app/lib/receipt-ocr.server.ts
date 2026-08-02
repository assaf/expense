import { createRequire } from "node:module";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { RECEIPT_OCR_MODE } from "~/lib/env";
import { extractReceipt, isVisionUnsupportedError } from "./receipt-ai.server";
import type { ExtractionResult } from "./receipt-ai.server";

/**
 * pdfjs runs its "fake worker" on the main thread. It normally loads
 * pdf.worker.mjs through a dynamic import whose specifier is a variable
 * annotated with a bundler ignore-hint — Vite and Vercel's tracer never
 * follow it, so the worker file is missing from the serverless bundle and
 * every PDF fails with "Setting up fake worker failed: Cannot find module
 * …pdf.worker.mjs". Statically importing the module and exposing its
 * WorkerMessageHandler makes pdfjs use it directly, with no file load — the
 * same code path its fake worker would have taken.
 */
globalThis.pdfjsWorker = pdfjsWorker;

/**
 * OCR + PDF handling for receipt attachments.
 *
 * PDFs get their text layer extracted with pdf.js; when that comes back empty
 * (scanned PDF) the pages are rasterized to a PNG and OCR'd. Images are
 * normalized (HEIC/webp→png, alpha flattened, downscaled) and then OCR'd.
 *
 * OCR backend is selected by RECEIPT_OCR_MODE:
 *  - "auto" (default): try DeepSeek vision first, fall back to tesseract
 *  - "deepseek": DeepSeek vision only
 *  - "tesseract": local OCR only (tesseract.js, worker/core/lang fetched from
 *    a CDN at runtime — safe for serverless bundles)
 */

/** Normalize an image for OCR: decode, flatten alpha, cap width at 3000px. */
async function normalizeImage(buffer: Buffer, _mime: string): Promise<Buffer> {
  let img = sharp(buffer);
  const meta = await img.metadata().catch(() => null);
  if (!meta?.width) return buffer; // not decodable by sharp — pass through
  if (meta.width > 3000) {
    img = img.resize({ width: 3000, withoutEnlargement: true });
  }
  const png = await img
    .flatten({ background: "#ffffff" })
    .png({ compressionLevel: 6 })
    .toBuffer();
  return png;
}

/**
 * Convert an attachment image to a browser-friendly format for storage:
 * HEIC/BMP/TIFF/AVIF → PNG; JPEG/PNG/WebP pass through (alpha flattened,
 * downscaled past 1024px). The stored receipt must render in <img> tags.
 * The width cap mirrors saveImage's normalization (see image-normalize.ts)
 * so the intermediate stays small — re-encoding happens once, at save.
 */
async function toBrowserImage(
  buffer: Buffer,
  mime: string,
): Promise<{ buffer: Buffer; mime: string }> {
  let img = sharp(buffer);
  const meta = await img.metadata().catch(() => null);
  if (!meta?.width) return { buffer, mime }; // not decodable — pass through
  if (meta.width > 1024) {
    img = img.resize({ width: 1024, withoutEnlargement: true });
  }
  if (
    [
      "image/heic",
      "image/heif",
      "image/bmp",
      "image/tiff",
      "image/avif",
    ].includes(mime)
  ) {
    return {
      buffer: await img.png({ compressionLevel: 6 }).toBuffer(),
      mime: "image/png",
    };
  }
  return {
    buffer: await img.flatten({ background: "#ffffff" }).toBuffer(),
    mime,
  };
}

const nodeRequire = createRequire(import.meta.url);

/**
 * Absolute path to tesseract.js's Node worker script. Node's worker_threads
 * only accepts a local file path (a CDN URL throws ERR_WORKER_PATH); the
 * script is small, and the wasm core is required from tesseract.js-core at
 * runtime. Only the traineddata (`langPath`) is fetched from a CDN.
 *
 * The core loads the base64-embedded `.wasm.js` variants (patched via
 * patches/tesseract.js@7.0.0.patch) instead of the separate `.wasm` files,
 * because Vercel's dependency tracer ships JS but drops binary `.wasm`
 * references — the embedded variants survive tracing.
 */
const TESSERACT_NODE_WORKER = nodeRequire.resolve(
  "tesseract.js/src/worker-script/node/index.js",
);

/**
 * OCR an image with tesseract.js. The wasm core comes from the local
 * tesseract.js-core package; traineddata downloads from a CDN at runtime.
 */
async function ocrImage(buffer: Buffer, mime: string): Promise<string> {
  const png = await normalizeImage(buffer, mime);
  const worker = await createWorker(["eng"], 1, {
    workerPath: TESSERACT_NODE_WORKER,
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
  });
  try {
    const { data } = await worker.recognize(png);
    return (data.text ?? "").trim();
  } finally {
    await worker.terminate();
  }
}

/**
 * pdf.js fetches the standard-14 fonts (Helvetica etc.) from the package's
 * standard_fonts dir; in serverless bundles that dir isn't shipped, so point
 * at the CDN copy. Non-fatal if unreachable — text extraction still works.
 */
const PDFJS_STANDARD_FONTS =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/standard_fonts/";

function pdfData(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer);
}

/**
 * Node has no FontFace API — render glyphs as paths (disableFontFace) and
 * fetch standard-font metrics from the CDN copy of pdfjs-dist.
 */
const pdfParams = {
  disableFontFace: true,
  standardFontDataUrl: PDFJS_STANDARD_FONTS,
  useWorkerFetch: false,
  verbosity: 0,
} as const;

/** Extract the text layer of a PDF (up to the first 4 pages). */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const task = getDocument({
    data: pdfData(buffer),
    ...pdfParams,
  });
  const doc = await task.promise;
  try {
    const out: string[] = [];
    const pages = Math.min(doc.numPages, 4);
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) out.push(text);
    }
    return out.join("\n");
  } finally {
    await task.destroy();
  }
}

/**
 * Rasterize a PDF to a single stacked PNG (up to 3 pages, scale 2).
 * Used both as the stored receipt image and as the OCR input for scanned PDFs.
 */
export async function renderPdfToPng(buffer: Buffer): Promise<Buffer> {
  const task = getDocument({
    data: pdfData(buffer),
    ...pdfParams,
  });
  const doc = await task.promise;
  try {
    const pages = Math.min(doc.numPages, 3);
    const rendered: { canvas: Canvas }[] = [];
    let width = 0;
    let height = 0;
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, viewport.width, viewport.height);
      await page.render({
        canvasContext: ctx,
        viewport,
      } as unknown as Parameters<typeof page.render>[0]).promise;
      rendered.push({ canvas });
      width = Math.max(width, viewport.width);
      height += viewport.height;
    }
    if (rendered.length === 0) throw new Error("PDF has no renderable pages");
    if (rendered.length === 1) {
      return rendered[0]!.canvas.toBuffer("image/png");
    }
    const stacked = createCanvas(width, height);
    const ctx = stacked.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    let y = 0;
    for (const { canvas } of rendered) {
      ctx.drawImage(canvas, 0, y);
      y += canvas.height;
    }
    return stacked.toBuffer("image/png");
  } finally {
    await task.destroy();
  }
}

/**
 * Extract structured receipt data from an image attachment. Tries DeepSeek
 * vision first (RECEIPT_OCR_MODE !== "tesseract"); on a vision-unsupported
 * error (or when forced to tesseract) falls back to local OCR + text parsing.
 * `stored` is the normalized, browser-friendly image for saving as the
 * receipt image.
 */
export async function extractFromImage(input: {
  buffer: Buffer;
  mime: string;
  categories?: string[];
}): Promise<{
  result: ExtractionResult;
  text: string;
  stored: { buffer: Buffer; mime: string };
}> {
  const stored = await toBrowserImage(input.buffer, input.mime);
  let result: ExtractionResult | null = null;
  let text = "";
  if (RECEIPT_OCR_MODE !== "tesseract") {
    try {
      result = await extractReceipt({
        image: { buffer: stored.buffer, mime: stored.mime },
        categories: input.categories,
      });
    } catch (err) {
      if (RECEIPT_OCR_MODE === "deepseek" || !isVisionUnsupportedError(err)) {
        throw err;
      }
      // Vision not supported by the hosted API — fall back to local OCR.
    }
  }
  if (!result) {
    text = await ocrImage(stored.buffer, stored.mime);
    result = await extractReceipt({
      text,
      categories: input.categories,
    });
  }
  return { result, text, stored };
}
