import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "~/lib/reconcile.server";
import { htmlToText } from "~/lib/receipt-render.server";

/**
 * HTML email fixtures. Each `.html` file in test/fixtures/emails/ is a
 * receipt email with no PDF/image attachment (the body is the receipt),
 * paired with a `<name>.csv` carrying the ground truth: `date,amount,
 * merchant,text` — the receipt's date, total, and merchant name plus the
 * full extracted text. This test reduces each email body to text with the
 * same `htmlToText` the inbound pipeline uses, and asserts it recovers the
 * date, amount, merchant, and the full text.
 *
 * Comparison is normalized to [A-Z0-9] (case/spacing/punctuation-insensitive)
 * — HTML source and rendering differ across email clients, so exact
 * whitespace carries no meaning.
 */

const FIXTURES_DIR = "test/fixtures/emails";

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Personal identifiers that must never appear in the fixtures' HTML source
 * or extracted text. Redacted by scripts/redact-emails.py: the account
 * holder's name, emails on their domains, home street/unit/zip, card suffix,
 * and account numbers. Names are word-boundary matched — "arkin" is a
 * substring of "PARKING", which is a merchant.
 */
const PII_NAMES = /\b(assaf|arkin)\b/i;
const PII_OTHER = ["@labnotes", "@arkin", "1050 s flower", "apt 503"];
const PII_NUMBERS = [
  /\b90015\b/,
  /\b1476\b/,
  /\b3870\b/,
  /8838/,
  /28ba0cb08c/,
  /trxabx/i,
  /867530/,
];

/** Email source files: everything ending in .html (the companion CSV shares
 * the basename). */
const emails = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".html"))
  .sort();

function expectNoPii(source: string, label: string): void {
  expect(PII_NAMES.test(source), `${label}: a name leaked`).toBe(false);
  for (const p of PII_OTHER) {
    expect(source.includes(p), `${label}: "${p}" leaked`).toBe(false);
  }
  for (const rx of PII_NUMBERS) {
    expect(rx.test(source), `${label}: ${rx} leaked`).toBe(false);
  }
}

describe("HTML email fixtures parse to their expected text", () => {
  for (const file of emails) {
    it(`extracts the text of ${file}`, () => {
      const basename = file.replace(/\.html$/, "");
      const rows = parseCsv(
        readFileSync(`${FIXTURES_DIR}/${basename}.csv`, "utf8"),
      );
      const data = rows[1]!;
      const date = data[0]!.trim();
      const amount = data[1]!.trim();
      const merchant = data[2]!.trim();
      const text = (data[3] ?? "").trim();

      const norm = normalize(
        htmlToText(readFileSync(`${FIXTURES_DIR}/${file}`, "utf8")),
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
      expect(norm, `${file}: full email text not recovered`).toContain(
        normalize(text),
      );
    });

    it(`has ${file} fully redacted (no personal information)`, () => {
      const html = readFileSync(`${FIXTURES_DIR}/${file}`, "utf8");
      expectNoPii(html.toLowerCase(), `${file} HTML`);
      expectNoPii(htmlToText(html).toLowerCase(), `${file} text`);
    });
  }
});
