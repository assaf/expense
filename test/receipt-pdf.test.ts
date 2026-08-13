import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { extractPdfText } from "~/lib/receipt-ocr.server";

/**
 * PDF receipt fixtures. Each PDF in test/fixtures/pdf/ is a receipt with a
 * text layer, paired with a `<name>.yaml` carrying the receipt's ground truth:
 * `date,amount,merchant,text` — the printed date, total, and merchant name
 * plus the full extracted text. This test extracts each PDF's text layer with
 * the real pdf.js pipeline (`extractPdfText`, the same function the receipt
 * pipeline uses) and asserts the text recovers the date, amount, merchant,
 * and the full receipt text.
 *
 * Unlike the image OCR test (gated behind RUN_OCR_TESTS), text extraction is
 * deterministic and offline, so this runs in the normal suite. Comparison is
 * normalized to [A-Z0-9] (case/spacing/punctuation-insensitive) — pdf.js
 * joins glyphs into a single string, so whitespace and separator characters
 * carry no information.
 */

const FIXTURES_DIR = "test/fixtures/pdf";

/**
 * Personal identifiers that must never appear in the fixtures' text layer.
 * Redacted by scripts/redact-receipts.py: the account-holder name, personal
 * email, home street/unit/zip, and the card suffix. Names are word-boundary
 * matched — "arkin" is a substring of "PARKING", which is a merchant.
 */
const PII_NAMES = /\b(assaf|arkin)\b/i;
const PII_OTHER = ["@labnotes", "1050 flower", "1050 south flower", "apt 503"];
const PII_ZIP = /\b(90015|94606)\b/;
const PII_CARD = /\b1476\b/;

interface Fixture {
  date: string;
  amount: string;
  merchant: string;
  text: string;
}

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** PDF receipt files: everything ending in .pdf (the companion YAML shares the
 * basename). */
const pdfs = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".pdf"))
  .sort();

describe("PDF receipt fixtures parse to their expected text", () => {
  for (const file of pdfs) {
    it(`extracts the text of ${file}`, async () => {
      const basename = file.replace(/\.pdf$/, "");
      const { date, amount, merchant, text } = parseYaml(
        readFileSync(`${FIXTURES_DIR}/${basename}.yaml`, "utf8"),
      ) as Fixture;

      const norm = normalize(
        await extractPdfText(readFileSync(`${FIXTURES_DIR}/${file}`)),
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
    });

    it(`has ${file} fully redacted (no personal information in the text layer)`, async () => {
      const all = (
        await extractPdfText(readFileSync(`${FIXTURES_DIR}/${file}`))
      ).toLowerCase();
      expect(PII_NAMES.test(all), "a name leaked").toBe(false);
      for (const p of PII_OTHER) {
        expect(all.includes(p), `"${p}" leaked`).toBe(false);
      }
      expect(PII_ZIP.test(all), "a home zip code leaked").toBe(false);
      expect(PII_CARD.test(all), "the card suffix leaked").toBe(false);
    });
  }
});
