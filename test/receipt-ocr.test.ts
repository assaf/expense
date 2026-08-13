import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ocrImage } from "~/lib/receipt-ocr.server";

/**
 * Receipt-image OCR fixtures. Each PNG in test/fixtures/images/ is a receipt
 * text sheet rendered by `renderReceiptImage` (the app's own email-receipt
 * renderer), paired with a `<name>.yaml` carrying the receipt's ground truth:
 * `date,amount,merchant,text` — the printed date, total, and merchant name
 * plus the full receipt text. This test OCRs each image with the real
 * tesseract pipeline (`ocrImage`) and asserts the recognized text recovers
 * the date, amount, merchant, and the full receipt text.
 *
 * Skipped unless RUN_OCR_TESTS=1: tesseract downloads eng.traineddata from a
 * CDN on first run (network + a few seconds), so it's opt-in locally and on
 * in CI — the same gate as pdf-ocr.test.ts. Comparison runs on text
 * normalized to [A-Z0-9] (case/spacing/punctuation-insensitive) because OCR
 * output never reproduces whitespace and separator lines exactly.
 */

const FIXTURES_DIR = "test/fixtures/images";

interface Fixture {
  date: string;
  amount: string;
  merchant: string;
  text: string;
}

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Receipt image files: everything ending in .png (the companion YAML shares
 * the basename). */
const images = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".png"))
  .sort();

describe.skipIf(!process.env.RUN_OCR_TESTS)("receipt image OCR", () => {
  for (const file of images) {
    it(`OCRs ${file}`, async () => {
      const basename = file.replace(/\.png$/, "");
      const { date, amount, merchant, text } = parseYaml(
        readFileSync(`${FIXTURES_DIR}/${basename}.yaml`, "utf8"),
      ) as Fixture;

      const norm = normalize(
        await ocrImage(readFileSync(`${FIXTURES_DIR}/${file}`)),
      );

      expect(norm, `${file}: date "${date}" not recovered`).toContain(
        normalize(date),
      );
      expect(norm, `${file}: amount "${amount}" not recovered`).toContain(
        normalize(amount),
      );
      expect(norm, `${file}: merchant "${merchant}" not recovered`).toContain(
        normalize(merchant),
      );
      expect(norm, `${file}: full receipt text not recovered`).toContain(
        normalize(text),
      );
    }, 120_000);
  }
});
