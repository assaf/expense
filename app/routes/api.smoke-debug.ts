import { timingSafeEqual } from "node:crypto";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { SMOKE_TEST_SECRET } from "~/lib/env";
import {
  extractPdfText,
  ocrImage,
  renderPdfToPng,
} from "~/lib/receipt-ocr.server";
import type { Route } from "./+types/api.smoke-debug";

/**
 * TEMPORARY diagnostic endpoint — delete after the serverless OCR failure
 * is diagnosed. Same gate as /api/smoke. Reports PNG pixel stats so we can
 * tell "pdfjs rendered blank" apart from "tesseract returned empty".
 */
export const config = { maxDuration: 60 };

function makePdf(text: string, size = 40): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ size: "LETTER" });
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(size).text(text);
    doc.end();
  });
}

function hasSmokeSecret(header: string | null): boolean {
  if (!SMOKE_TEST_SECRET || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(SMOKE_TEST_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function pngStats(png: Buffer) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let dark = 0;
  const n = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
    sum += v;
    if (v < 128) dark++;
  }
  return {
    width: info.width,
    height: info.height,
    mean: Math.round((sum / n) * 10) / 10,
    darkFraction: Math.round((dark / n) * 100_000) / 100_000,
  };
}

export async function loader({ request }: Route.LoaderArgs) {
  if (!hasSmokeSecret(request.headers.get("x-smoke-secret"))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const out: Record<string, unknown> = {};
  try {
    const pdf = await makePdf("SMOKE RECEIPT TOTAL $12.34");
    out.pdfBytes = pdf.length;
    out.pdfText = (await extractPdfText(pdf)).replace(/\s+/g, " ").trim();
    const png = await renderPdfToPng(pdf);
    out.pngBytes = png.length;
    out.pngStats = await pngStats(png);
    out.ocrPdf = (await ocrImage(png, "image/png")).trim();
    out.ok = true;
  } catch (err) {
    out.ok = false;
    out.error =
      err instanceof Error
        ? `${err.message} :: ${(err.stack ?? "").split("\n").slice(0, 3).join(" / ")}`
        : String(err);
  }
  return Response.json(out);
}
