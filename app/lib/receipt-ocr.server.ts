import { createRequire } from "node:module";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { isPdf } from "~/lib/file-types";
import { resizeIfWider, STORED_IMAGE_MAX_WIDTH } from "~/lib/image-normalize";
import { pdfImageName } from "~/lib/images.server";
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
async function normalizeImage(buffer: Buffer): Promise<Buffer> {
  const resized = await resizeIfWider(buffer, 3000);
  if (resized === null) return buffer; // not decodable by sharp — pass through
  return sharp(resized)
    .flatten({ background: "#ffffff" })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/**
 * Convert an attachment image to a browser-friendly format for OCR + storage:
 * HEIC/BMP/TIFF/AVIF → PNG (tesseract can't read them); JPEG/PNG/WebP pass
 * through downscaled to the storage cap. JPEG is returned without re-encoding
 * — it has no alpha, so flatten is a no-op, and saveImage's normalizer
 * (normalizeStoredImage, same width cap) handles storage without a second
 * lossy pass. PNG/WebP are flattened onto white here because OCR sees this
 * buffer before storage does.
 */
async function toBrowserImage(
  buffer: Buffer,
  mime: string,
): Promise<{ buffer: Buffer; mime: string }> {
  const resized = await resizeIfWider(buffer, STORED_IMAGE_MAX_WIDTH);
  if (resized === null) return { buffer, mime }; // not decodable — pass through
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
      buffer: await sharp(resized).png({ compressionLevel: 6 }).toBuffer(),
      mime: "image/png",
    };
  }
  if (mime === "image/jpeg") {
    // JPEG never has an alpha channel: flatten is a no-op, so the bytes go
    // to saveImage untouched (small JPEGs pass its normalizer as-is).
    return { buffer: resized, mime };
  }
  return {
    buffer: await sharp(resized).flatten({ background: "#ffffff" }).toBuffer(),
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
export async function ocrImage(buffer: Buffer): Promise<string> {
  const png = await normalizeImage(buffer);
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
 *
 * useWorkerFetch MUST be true: in the Node build it makes the worker fetch
 * standard-font data over HTTP (fetchBinaryData). With useWorkerFetch: false
 * the data is read via fs.readFile(standardFontDataUrl) — a CDN URL can't be
 * read as a file, so the font falls back to built-in rendering, which
 * produces visible glyphs locally but BLANK pages in the serverless bundle
 * (confirmed via the /api/smoke PNG pixel stats: mean 255, darkFraction 0).
 */
const PDFJS_STANDARD_FONTS =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/standard_fonts/";

function pdfData(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer);
}

/**
 * Node has no FontFace API — render glyphs as paths (disableFontFace) and
 * fetch standard-font data from the CDN copy of pdfjs-dist over HTTP.
 */
const pdfParams = {
  disableFontFace: true,
  standardFontDataUrl: PDFJS_STANDARD_FONTS,
  useWorkerFetch: true,
  verbosity: 0,
} as const;

/** Detect a PDF by mime or magic bytes — covers mislabeled uploads. */
function isPdfInput(buffer: Buffer, mime: string): boolean {
  return isPdf({ buffer, mime });
}

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
 * Rasterize an uploaded PDF to a PNG for storage and rename it to *.png
 * (`receipt.pdf` → `receipt.png`). Throws when the PDF can't be rendered —
 * callers turn that into their own "couldn't read the PDF" response (the
 * draft and editor routes differ only in their log tag).
 */
export async function rasterizePdfUpload(uploaded: {
  buffer: Buffer;
  originalName: string;
}): Promise<{ buffer: Buffer; mime: "image/png"; originalName: string }> {
  const buffer = await renderPdfToPng(uploaded.buffer);
  return {
    buffer,
    mime: "image/png",
    originalName: pdfImageName(uploaded.originalName),
  };
}

/**
 * Extract structured receipt data from an image attachment. Tries DeepSeek
 * vision first (RECEIPT_OCR_MODE !== "tesseract"); on a vision-unsupported
 * error (or when forced to tesseract) falls back to local OCR + text parsing.
 * `stored` is the normalized, browser-friendly image for saving as the
 * receipt image.
 *
 * PDFs are rasterized to PNG first — the stored image must be displayable in
 * an <img> — and extraction prefers the PDF text layer, only OCR'ing the
 * rendered pages when the text is empty (scanned PDF). Mirrors the
 * inbound-email path; a corrupt/undecodable PDF throws here and callers
 * decide the fate (the draft flow stores nothing and surfaces the error).
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
  if (isPdfInput(input.buffer, input.mime)) {
    const pdfText = await extractPdfText(input.buffer);
    const png = await renderPdfToPng(input.buffer);
    const result =
      pdfText.trim().length >= 20
        ? await extractReceipt({
            text: pdfText,
            categories: input.categories,
          })
        : (
            await extractFromImage({
              buffer: png,
              mime: "image/png",
              categories: input.categories,
            })
          ).result;
    return {
      result,
      text: pdfText,
      stored: { buffer: png, mime: "image/png" },
    };
  }

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
    text = await ocrImage(stored.buffer);
    result = await extractReceipt({
      text,
      categories: input.categories,
    });
  }
  return { result, text, stored };
}
