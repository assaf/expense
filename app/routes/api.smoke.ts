import { timingSafeEqual } from "node:crypto";
import PDFDocument from "pdfkit";
import { SMOKE_TEST_SECRET } from "~/lib/env";
import { pdfToBuffer } from "~/lib/pdf.server";
import {
  extractPdfText,
  ocrImage,
  renderPdfToPng,
} from "~/lib/receipt-ocr.server";
import type { Route } from "./+types/api.smoke";

/**
 * Post-deploy smoke test for the PDF + OCR pipeline (GET /api/smoke).
 *
 * Runs the exact code path the receipt pipeline uses — pdfkit → pdfjs text
 * extraction → pdfjs rasterization → tesseract OCR — inside the deployed
 * serverless bundle. Local/CI tests run against node_modules, where every
 * file is present; this is the only place the real Vercel bundle is
 * exercised, and Vercel's dependency tracer is exactly what drops files
 * (pdf.worker.mjs, tesseract wasm) and breaks PDF/OCR in production (see
 * receipt-ocr.server.ts). `scripts/deploy` curls this after every
 * production deployment and fails the deploy if it doesn't pass.
 *
 * Disabled unless SMOKE_TEST_SECRET is configured; requests must send it in
 * the `x-smoke-secret` header so the route isn't a public CPU/bandwidth
 * sink (PDF rendering + OCR are expensive).
 */

// Vercel: tesseract downloads eng.traineddata on the first cold start.
export const config = { maxDuration: 60 };

const SMOKE_TEXT = "SMOKE RECEIPT TOTAL $12.34";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function hasSmokeSecret(header: string | null): boolean {
  if (!SMOKE_TEST_SECRET || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(SMOKE_TEST_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A one-page LETTER PDF with the smoke text at 40pt (readable by OCR). */
function makePdf(text: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER" });
  const pdf = pdfToBuffer(doc);
  doc.fontSize(40).text(text);
  doc.end();
  return pdf;
}

function fail(message: string): Response {
  console.error(`[smoke] ${message}`);
  return Response.json({ ok: false, error: message }, { status: 500 });
}

export async function loader({ request }: Route.LoaderArgs) {
  if (!hasSmokeSecret(request.headers.get("x-smoke-secret"))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const started = Date.now();
  try {
    const pdf = await makePdf(SMOKE_TEXT);
    const pdfText = (await extractPdfText(pdf)).replace(/\s+/g, " ").trim();
    if (!pdfText.includes(SMOKE_TEXT)) {
      return fail(`pdfjs text extraction failed: got "${pdfText}"`);
    }

    const png = await renderPdfToPng(pdf);
    if (!png.subarray(0, 8).equals(PNG_MAGIC) || png.length < 10_000) {
      return fail(`PDF rasterization produced a bad PNG (${png.length} bytes)`);
    }

    const ocrText = (await ocrImage(png)).toUpperCase();
    const norm = ocrText.replace(/[^A-Z0-9]/g, "");
    if (
      !norm.includes("SMOKE") ||
      !norm.includes("RECEIPT") ||
      !norm.includes("1234")
    ) {
      return fail(`tesseract OCR did not recover the smoke text: "${ocrText}"`);
    }

    return Response.json({
      ok: true,
      pdfText,
      ocrText,
      pngBytes: png.length,
      ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[smoke] PDF/OCR check threw:", err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
