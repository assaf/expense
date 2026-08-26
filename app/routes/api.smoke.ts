import * as Sentry from "@sentry/react-router";
import { SMOKE_TEST_SECRET } from "~/lib/env";
import { captureError } from "~/lib/errors.server";
import { runMcpSmoke } from "~/lib/mcp.server";
import { safeEqual } from "~/lib/passwords";
import { pdfToBuffer } from "~/lib/pdf.server";
import {
  extractPdfText,
  ocrImage,
  renderPdfToPng,
} from "~/lib/receipt-ocr.server";
import type { Route } from "./+types/api.smoke";

/**
 * Post-deploy smoke test for the PDF + OCR + MCP pipelines (GET /api/smoke).
 *
 * Runs the exact code paths the receipt pipeline uses (pdfkit → pdfjs text
 * extraction → pdfjs rasterization → tesseract OCR), plus a real MCP
 * initialize → tools/list → tools/call round trip (see runMcpSmoke) inside
 * the deployed serverless bundle. Local/CI tests run against node_modules,
 * where every file is present; this is the only place the real Vercel bundle
 * is exercised, and Vercel's dependency tracer is exactly what drops files
 * (pdf.worker.mjs, tesseract wasm, MCP SDK modules) and breaks these
 * pipelines in production (see receipt-ocr.server.ts / mcp.server.ts).
 * `scripts/deploy` curls this after every production deployment and fails
 * the deploy if it doesn't pass.
 *
 * Disabled unless SMOKE_TEST_SECRET is configured; requests must send it in
 * the `x-smoke-secret` header so the route isn't a public CPU/bandwidth
 * sink (PDF rendering + OCR are expensive).
 */

// Vercel: tesseract downloads eng.traineddata on the first cold start.
export const config = { maxDuration: 15 };

const SMOKE_TEXT = "SMOKE RECEIPT TOTAL $12.34";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function hasSmokeSecret(header: string | null): boolean {
  if (!SMOKE_TEST_SECRET || !header) return false;
  return safeEqual(header, SMOKE_TEST_SECRET);
}

/** A one-page LETTER PDF with the smoke text at 40pt (readable by OCR). */
async function makePdf(text: string): Promise<Buffer> {
  const [{ default: PDFDocument }] = await Promise.all([
    import("pdfkit"),
    import("@expense/pdfkit-standard-fonts"),
  ]);
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

    // MCP round trip: a fresh token (revoked immediately after) exercises
    // the endpoint the same way a client would, inside this bundle.
    const mcp = await runMcpSmoke();

    return Response.json({
      ok: true,
      pdfText,
      ocrText,
      pngBytes: png.length,
      mcp,
      // Server Sentry init lives in the bundle (entry.server.tsx); this is
      // the one place the real deployed function is exercised, so report
      // whether it actually initialized. False here means server errors are
      // console-only again (see scripts/smoke-check).
      sentryInitialized: Sentry.isInitialized(),
      ms: Date.now() - started,
    });
  } catch (err) {
    captureError(err);
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
