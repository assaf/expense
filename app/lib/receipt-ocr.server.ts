import { createRequire } from "node:module";
import type { Canvas } from "@napi-rs/canvas";
import type { PDFPageProxy } from "pdfjs-dist";
import { detectImageMime, isPdf } from "~/lib/file-types";
import { convertToUsd } from "~/lib/fx.server";
import { fxProvenance } from "~/lib/fx-note";
import { resizeIfWider, STORED_IMAGE_MAX_WIDTH } from "~/lib/image-normalize";
import {
  pdfImageName,
  readUploadedFile,
  saveImage,
  uploadErrorMessage,
} from "~/lib/images.server";
import { RECEIPT_OCR_MODE, RECEIPT_VISION_MAX_WIDTH } from "~/lib/env";
import { readExtractionContext } from "~/lib/db/extraction-context";
import {
  composeLocalDescription,
  extractReceipt,
  parseReceiptAmount,
  resolveExtraction,
  tryKnownMerchantExtraction,
  type KnownMerchant,
} from "./receipt-ai.server";
import type { ExtractionResult } from "./receipt-ai.server";
import type { Worker } from "tesseract.js";

/**
 * pdfjs runs its "fake worker" on the main thread. It normally loads
 * pdf.worker.mjs through a dynamic import whose specifier is a variable
 * annotated with a bundler ignore-hint; Vite and Vercel's tracer never
 * follow it, so the worker file is missing from the serverless bundle and
 * every PDF fails with "Setting up fake worker failed: Cannot find module
 * …pdf.worker.mjs". Importing the module (dynamically, with a literal
 * specifier the tracer follows) and exposing its WorkerMessageHandler makes
 * pdfjs use it directly, with no file load, the same code path its fake
 * worker would have taken.
 */
let pdfjsPromise: Promise<
  typeof import("pdfjs-dist/legacy/build/pdf.mjs")
> | null = null;

/** Load pdfjs + its worker on first use; both stay out of the eager graph. */
function loadPdfjs() {
  pdfjsPromise ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ]).then(([pdfjs, worker]) => {
    globalThis.pdfjsWorker = worker;
    return pdfjs;
  });
  return pdfjsPromise;
}

/**
 * OCR + PDF handling for receipt attachments.
 *
›
 * PDFs get their text layer extracted with pdf.js; when that comes back empty
 * (scanned PDF) the pages are rasterized to a PNG and read by the image path
 * below. Images are normalized (HEIC/webp→png, alpha flattened, downscaled)
 * and extracted with the RECEIPT_OCR_MODE backend:
 *  - "auto" (default): DeepSeek vision first (no local OCR CPU on the happy
 *    path); tesseract runs only when the provider errors
 *  - "deepseek": DeepSeek vision only
 *  - "tesseract": local OCR only (tesseract.js, worker/core/lang fetched from
 *    a CDN at runtime, which is safe for serverless bundles)
 */

/** Normalize an image for OCR: decode, flatten alpha, cap width at 3000px. */
async function normalizeImage(buffer: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const resized = await resizeIfWider(buffer, 3000);
  if (resized === null) return buffer; // not decodable by sharp: pass through
  return sharp(resized)
    .flatten({ background: "#ffffff" })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/**
 * Convert an attachment image to a browser-friendly format for OCR + storage:
 * HEIC/BMP/TIFF/AVIF → PNG (tesseract can't read them); JPEG/PNG/WebP pass
 * through downscaled to the storage cap. JPEG is returned without re-encoding
 * (no alpha, so flatten is a no-op; saveImage's normalizer handles storage).
 * Declared mimes that aren't image types (e.g. application/octet-stream from
 * a phone attachment) are sniffed from the bytes first, so the stored receipt
 * serves with a displayable mime and the vision data-URL is valid.
 */
async function toBrowserImage(
  buffer: Buffer,
  mime: string,
): Promise<{ buffer: Buffer; mime: string }> {
  const sharp = (await import("sharp")).default;
  // Attachments often arrive as application/octet-stream with a UUID
  // filename (no extension to sniff). Recover the real image type from the
  // bytes so the stored receipt serves with a displayable mime and the
  // vision data-URL is valid.
  if (!mime.toLowerCase().startsWith("image/")) {
    const sniffed = detectImageMime(buffer);
    if (sniffed) mime = sniffed;
  }
  const resized = await resizeIfWider(buffer, STORED_IMAGE_MAX_WIDTH);
  if (resized === null) return { buffer, mime }; // not decodable, so pass through
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
 * references; the embedded variants survive tracing.
 */
const TESSERACT_NODE_WORKER = nodeRequire.resolve(
  "tesseract.js/src/worker-script/node/index.js",
);

/**
 * Singleton tesseract worker, created lazily and reused across calls. The
 * wasm core comes from the local tesseract.js-core package; traineddata
 * downloads from a CDN once per process. A per-call worker paid WASM init +
 * (in serverless) a fresh traineddata download on every OCR: seconds of
 * cold-start latency per image. One worker serializes recognize jobs
 * internally, so concurrent calls queue instead of spawning workers. Reset
 * on error: a failed recognize can leave the worker in a bad state, and the
 * next call recreates it.
 */
let ocrWorker: Worker | null = null;

async function getOcrWorker() {
  if (!ocrWorker) {
    // tesseract.js is heavy; load it only when OCR actually runs (the
    // package, wasm core, and traineddata all load on first worker
    // creation). Importing here keeps cold starts of non-OCR requests
    // from parsing it.
    const { createWorker } = await import("tesseract.js");
    ocrWorker = await createWorker(["eng"], 1, {
      workerPath: TESSERACT_NODE_WORKER,
      langPath: "https://tessdata.projectnaptha.com/4.0.0",
    });
  }
  return ocrWorker;
}

/** OCR an image with tesseract.js. */
export async function ocrImage(buffer: Buffer): Promise<string> {
  const png = await normalizeImage(buffer);
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(png);
    return (data.text ?? "").trim();
  } catch (err) {
    ocrWorker = null;
    throw err;
  }
}

/**
 * pdf.js fetches the standard-14 fonts (Helvetica etc.) from the package's
 * standard_fonts dir; in serverless bundles that dir isn't shipped, so point
 * at the CDN copy. Non-fatal if unreachable; text extraction still works.
 *
 * useWorkerFetch MUST be true: in the Node build it makes the worker fetch
 * standard-font data over HTTP (fetchBinaryData). With useWorkerFetch: false
 * the data is read via fs.readFile(standardFontDataUrl), and a CDN URL can't be
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
 * Node has no FontFace API, so render glyphs as paths (disableFontFace) and
 * fetch standard-font data from the CDN copy of pdfjs-dist over HTTP.
 */
const pdfParams = {
  disableFontFace: true,
  standardFontDataUrl: PDFJS_STANDARD_FONTS,
  useWorkerFetch: true,
  verbosity: 0,
} as const;

/**
 * Open a PDF and run `fn` over each of the first 4 pages' text content,
 * returning the per-page results. Always destroys the document (pdfjs
 * holds resources) even when `fn` throws. Shared by the text and line
 * extractors below, which only differ in how they consume the items.
 */
async function withPdfPages<T>(
  buffer: Buffer,
  fn: (tc: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>) => T,
): Promise<T[]> {
  const { getDocument } = await loadPdfjs();
  const task = getDocument({
    data: pdfData(buffer),
    ...pdfParams,
  });
  const doc = await task.promise;
  try {
    const pages = Math.min(doc.numPages, 4);
    const out: T[] = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      out.push(fn(await page.getTextContent()));
    }
    return out;
  } finally {
    await task.destroy();
  }
}

/** Extract the text layer of a PDF (up to the first 4 pages). */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const pages = await withPdfPages(buffer, (tc) =>
    tc.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return pages.filter(Boolean).join("\n");
}

/**
 * Extract the text layer of a PDF reconstructed into real lines (up to the
 * first 4 pages). Unlike `extractPdfText`, which joins every glyph on a
 * page into one string (fine for short receipts), this groups items by
 * their vertical position so tabular statements keep their row structure
 * (date, description, amount on the same line). Reconciliation needs the
 * lines, not the text.
 */
export async function extractPdfLines(buffer: Buffer): Promise<string[]> {
  const pages = await withPdfPages(buffer, (tc) => {
    // Group items by baseline (transform[5]); items within ~3px of the
    // current baseline belong to the same line, ordered left to right.
    const items = tc.items
      .flatMap((it) => {
        // TextMarkedContent (group markers) has no glyph/position data.
        if (!("str" in it)) return [];
        return [
          {
            text: it.str,
            x: it.transform?.[4] ?? 0,
            y: it.transform?.[5] ?? 0,
          },
        ];
      })
      .filter((it) => it.text.trim() !== "");
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: string[] = [];
    let current: { y: number; parts: string[] } | null = null;
    for (const it of items) {
      if (current && Math.abs(it.y - current.y) <= 3) {
        current.parts.push(it.text);
      } else {
        if (current) {
          lines.push(current.parts.join(" ").replace(/\s+/g, " ").trim());
        }
        current = { y: it.y, parts: [it.text] };
      }
    }
    if (current) {
      lines.push(current.parts.join(" ").replace(/\s+/g, " ").trim());
    }
    return lines.filter(Boolean);
  });
  return pages.flat();
}

/**
 * Rasterize a PDF to a single stacked PNG (up to 3 pages, scale 2).
 * Used both as the stored receipt image and as the OCR input for scanned PDFs.
 */
export async function renderPdfToPng(buffer: Buffer): Promise<Buffer> {
  const [{ getDocument }, { createCanvas }] = await Promise.all([
    loadPdfjs(),
    import("@napi-rs/canvas"),
  ]);
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
      // A crafted MediaBox can declare a huge page (e.g. 20000x20000 pt →
      // a multi-GB canvas allocation). The input byte cap doesn't bound the
      // decoded geometry, so clamp it here (mirroring sharp's
      // limitInputPixels) before createCanvas eagerly allocates.
      const MAX_PDF_RENDER_PX = 4000;
      const MAX_PDF_RENDER_PIXELS = 8_000_000;
      if (
        viewport.width > MAX_PDF_RENDER_PX ||
        viewport.height > MAX_PDF_RENDER_PX ||
        viewport.width * viewport.height > MAX_PDF_RENDER_PIXELS
      ) {
        throw new Error(
          `PDF page is too large to render (${Math.round(viewport.width)}x${Math.round(viewport.height)}px)`,
        );
      }
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
 * (`receipt.pdf` → `receipt.png`). Throws when the PDF can't be rendered;
 * callers turn that into their own "couldn't read the PDF" response (see
 * prepareUploadedReceipt).
 */
async function rasterizePdfUpload(uploaded: {
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
 * Resolve the bytes to store for an uploaded receipt file: PDFs are
 * rasterized to PNG before storage (receipts are always displayed as
 * images, and the thumbnail/export pipelines assume sharp-decodable
 * bytes). Non-PDFs pass through unchanged. Returns null when an unreadable
 * PDF fails to render, and callers turn that into their own "Couldn't read
 * that PDF" response. Shared by the draft-upload (/api/expense) and the
 * editor image-replace (/expense/:id/image) routes, which differ only in
 * their log tag; `wasPdf` lets the draft route skip OCR for PDFs and run
 * it alongside the save for images.
 */
export async function prepareUploadedReceipt(
  uploaded: { buffer: Buffer; mime: string; originalName: string },
  logTag: string,
): Promise<{
  buffer: Buffer;
  mime: string;
  originalName: string;
  wasPdf: boolean;
} | null> {
  if (!isPdf(uploaded)) return { ...uploaded, wasPdf: false };
  try {
    const pdf = await rasterizePdfUpload(uploaded);
    return {
      buffer: pdf.buffer,
      mime: pdf.mime,
      originalName: pdf.originalName,
      wasPdf: true,
    };
  } catch (err) {
    console.warn(`[${logTag}] PDF render failed:`, err);
    return null;
  }
}

/**
 * Read an uploaded receipt file from the form's `file` field, returning the
 * routes' shared 400 on rejection. The common prefix of every
 * upload-consuming intent (draft upload, image replace, OCR).
 */
export async function readUploadOr400(
  form: FormData,
): Promise<Response | { buffer: Buffer; mime: string; originalName: string }> {
  const uploaded = await readUploadedFile(form);
  if (!uploaded.ok) {
    return Response.json(
      { error: uploadErrorMessage(uploaded.error) },
      { status: 400 },
    );
  }
  return {
    buffer: uploaded.buffer,
    mime: uploaded.mime,
    originalName: uploaded.originalName,
  };
}

/**
 * Full upload-to-storage preamble for intents that persist receipt bytes:
 * readUploadOr400, PDF rasterization (an unreadable PDF is the shared
 * "Couldn't read that PDF." 400), then saveImage. Both persisting call
 * sites consume the result identically (filename/mime/originalName), so
 * storage lives here; OCR-only intents stop at readUploadOr400 instead.
 */
export async function prepareUploadOr400(
  form: FormData,
  accountId: string,
  logTag: string,
): Promise<
  Response | { filename: string; mime: string; originalName: string }
> {
  const uploaded = await readUploadOr400(form);
  if (uploaded instanceof Response) return uploaded;
  const prepared = await prepareUploadedReceipt(uploaded, logTag);
  if (prepared === null) {
    return Response.json({ error: "Couldn't read that PDF." }, { status: 400 });
  }
  const saved = await saveImage(
    accountId,
    prepared.buffer,
    prepared.mime,
    prepared.originalName,
  );
  return {
    filename: saved.filename,
    mime: saved.mime,
    originalName: prepared.originalName,
  };
}

/**
 * Extract structured receipt data from an image attachment. Text-mode
 * inputs (PDF text layer, tesseract fallback) go through the known-merchant
 * skip (tryKnownMerchantExtraction) before any model call; the image path
 * itself is vision-first: a local OCR pre-scan would add seconds of
 * latency to every upload, while the email/PDF paths get the skip for free.
 * LLM results are cached per account by input hash (extractReceipt), so
 * re-uploading the same receipt skips the call too.
 * `stored` is the normalized, browser-friendly image for saving as the
 * receipt image.
 *
 * PDFs are rasterized to PNG first (the stored image must be displayable in
 * an <img>), and extraction prefers the PDF text layer, only OCR'ing the
 * rendered pages when the text is empty (scanned PDF). Mirrors the
 * inbound-email path; a corrupt/undecodable PDF throws here and callers
 * decide the fate (the draft flow stores nothing and surfaces the error).
 */
export async function extractFromImage(input: {
  accountId: string;
  buffer: Buffer;
  mime: string;
  categories?: string[];
  reports?: string[];
  knownMerchants?: ReadonlyMap<string, KnownMerchant>;
}): Promise<{
  result: ExtractionResult;
  text: string;
  stored: { buffer: Buffer; mime: string };
}> {
  if (isPdf({ buffer: input.buffer, mime: input.mime })) {
    const pdfText = await extractPdfText(input.buffer);
    const png = await renderPdfToPng(input.buffer);
    const known = input.knownMerchants;
    const skipped = known ? tryKnownMerchantExtraction(pdfText, known) : null;
    const result =
      (skipped
        ? {
            ...skipped,
            // The skip must not lose the receipt's own context (bill ref,
            // billed account, Apple plan name). No subject here; the body
            // text alone carries the Apple markers.
            description: composeLocalDescription("", pdfText),
          }
        : null) ??
      (pdfText.trim().length >= 20
        ? await extractReceipt({
            accountId: input.accountId,
            text: pdfText,
            categories: input.categories,
            reports: input.reports,
          })
        : (
            await extractFromImage({
              accountId: input.accountId,
              buffer: png,
              mime: "image/png",
              categories: input.categories,
              reports: input.reports,
              knownMerchants: known,
            })
          ).result);
    return {
      result,
      text: pdfText,
      stored: { buffer: png, mime: "image/png" },
    };
  }

  const stored = await toBrowserImage(input.buffer, input.mime);
  let result: ExtractionResult | null = null;
  let text = "";
  // The vision call uses a downscaled copy: vision tokens scale with
  // pixels² and receipts are text-heavy (see RECEIPT_VISION_MAX_WIDTH).
  // resizeIfWider returns null when the image already fits or isn't
  // decodable; the original is used then.
  const visionExtraction = async (): Promise<ExtractionResult> => {
    const visionBuffer =
      (await resizeIfWider(stored.buffer, RECEIPT_VISION_MAX_WIDTH)) ??
      stored.buffer;
    return extractReceipt({
      accountId: input.accountId,
      image: { buffer: visionBuffer, mime: stored.mime },
      categories: input.categories,
      reports: input.reports,
    });
  };
  // OCR the stored image and extract only when the text has enough
  // structure to name a total (same floor as the PDF path). Sets text
  // either way: the caller's cache key and skip log carry the OCR output.
  const extractFromOcr = async (): Promise<void> => {
    text = await ocrImage(stored.buffer);
    const usableOcr =
      text.trim().length >= 20 && parseReceiptAmount(text) !== null;
    if (usableOcr) {
      result = await extractReceipt({
        accountId: input.accountId,
        text,
        categories: input.categories,
        reports: input.reports,
      });
    }
  };
  if (RECEIPT_OCR_MODE === "deepseek") {
    result = await visionExtraction();
  } else if (RECEIPT_OCR_MODE === "tesseract") {
    // Local OCR only: extract whenever the text has enough structure to
    // name a total (same floor as the PDF path).
    await extractFromOcr();
  } else {
    // "auto" mode: the LLM reads the image; tesseract runs only when the
    // provider errors. The model is the better reader for photocopies,
    // glare, and skew, so a weak vision result stands rather than
    // spending local OCR CPU on a rescue it would likely miss anyway.
    try {
      result = await visionExtraction();
    } catch (err) {
      console.error("[receipt-ocr] vision failed; falling back to OCR", err);
      await extractFromOcr();
    }
  }
  if (!result) {
    // Unreachable: every mode above either sets a result or throws (deepseek
    // and auto rethrow when nothing else produced one). Guards the non-null
    // return contract for callers.
    throw new Error("[receipt-ocr] extraction produced no result");
  }
  return { result, text, stored };
}

/**
 * OCR an uploaded receipt image and fill in the fields: merchant and amount
 * straight from the extraction, and the category as the merchant's previous
 * category when one exists (a merchant the user already categorized is
 * reused, not re-guessed), else the suggested category mapped onto one the
 * account already uses. A foreign-currency receipt converts `amount` to USD
 * at the exchange rate for `date` (the editor's current date field; the IRS
 * payment-date rule) and returns the conversion metadata for the editor to
 * carry through to the save. Throws when extraction fails, and callers
 * decide whether that is fatal (it isn't for drafts or edit-mode re-reads).
 * Shared by the draft upload (/api/expense) and the editor's image replace.
 */
export async function extractUploadedReceiptFields(
  accountId: string,
  buffer: Buffer,
  mime: string,
  /** YYYY-MM-DD the receipt is being dated as (browser-local today in the
   * editor); "" skips conversion since no rate can be keyed to it. */
  date = "",
): Promise<{
  merchant: string;
  /** USD (converted when the receipt is foreign); "" when unread. */
  amount: string;
  category: string;
  report: string;
  /** The receipt's detected currency ("USD" when none or unmarked). */
  currency: string;
  /** Printed amount in `currency`, set whenever the receipt isn't USD. */
  originalAmount: string;
  /** The applied rate and its as-of date; "" when no conversion happened. */
  fxRate: string;
  rateDate: string;
}> {
  const context = await readExtractionContext(accountId);
  const { result } = await extractFromImage({
    accountId,
    buffer,
    mime,
    categories: context.categories,
    reports: context.reports,
    knownMerchants: context.knownMerchants,
  });
  const resolved = resolveExtraction(context, {
    merchant: result.merchant,
    category: result.category,
    report: result.report,
  });
  const receiptCurrency = (result.currency || "USD").toUpperCase();
  const conversion = await convertToUsd(result.amount, receiptCurrency, date);
  return {
    merchant: result.merchant,
    amount: conversion ? conversion.amount : result.amount,
    category: resolved.category,
    report: resolved.report,
    ...fxProvenance(receiptCurrency, result.amount, conversion),
  };
}
