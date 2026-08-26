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
 * Runs every lazy heavy dependency once: pdfkit (PDF render), pdfjs text
 * extraction + rasterization, @napi-rs/canvas, sharp (image normalize),
 * tesseract OCR, puppeteer + sparticuz-chromium (email-image render),
 * @resvg/resvg-js (receipt-image render), plus a real MCP initialize →
 * tools/list → tools/call round trip (see runMcpSmoke) inside the deployed
 * serverless bundle. Rule: a heavy dep loaded lazily must appear here —
 * local tests run against full node_modules and can't see tracer drops. Local/CI tests run against node_modules,
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

// Vercel: tesseract downloads eng.traineddata and the email-image step
// inflates + launches the bundled chromium on the first cold start.
export const config = { maxDuration: 30 };

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

    // Email-image rendering: the puppeteer + sparticuz-chromium path the
    // checks above don't touch. Runs only on the deployed (Linux) function;
    // locally the sparticuz binary can't execute, so the unit suites cover
    // this via the playwright path instead.
    const { renderEmailImage } = await import("~/lib/email-render.server");
    const emailPng = await renderEmailImage(SMOKE_TEXT, {});
    if (!emailPng.subarray(0, 8).equals(PNG_MAGIC) || emailPng.length < 5_000) {
      return fail(
        `email-image rendering produced a bad PNG (${emailPng.length} bytes)`,
      );
    }

    // Receipt-image rendering: exercises @resvg/resvg-js (the report +
    // route-map stack), which no other step touches.
    const { renderReceiptImage } = await import("~/lib/receipt-render.server");
    const receiptPng = await renderReceiptImage(SMOKE_TEXT, {});
    if (
      !receiptPng.subarray(0, 8).equals(PNG_MAGIC) ||
      // A compact text receipt renders ~3KB; the floor only guards
      // against a degenerate/blank render (renderReceiptImage already
      // rejects blank output internally via hasInk).
      receiptPng.length < 1_000
    ) {
      return fail(
        `receipt-image rendering produced a bad PNG (${receiptPng.length} bytes)`,
      );
    }

    // MCP round trip: a fresh token (revoked immediately after) exercises
    // the endpoint the same way a client would, inside this bundle.
    const mcp = await runMcpSmoke();

    return Response.json({
      ok: true,
      pdfText,
      ocrText,
      pngBytes: png.length,
      emailPngBytes: emailPng.length,
      receiptPngBytes: receiptPng.length,
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
