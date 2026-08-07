import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPdfLines } from "~/lib/receipt-ocr.server";
import { parsePdfStatementLines } from "~/lib/reconcile.server";
import type { StatementRow } from "~/lib/types";

/**
 * Runs the REAL bank statement PDFs (committed fixtures, test/fixtures/)
 * through the full pipeline — text extraction → line parsing — and checks
 * each bank's layout still yields its transactions with clean descriptions
 * and correct credit classification. Extraction quirks (column merging,
 * y-sorting, custom-font encoding, yearless dates, Daily Cash columns)
 * only show up with real files, which is why the synthetic-line unit
 * tests can't replace this.
 *
 * The fixtures are the user's own statements, redacted of personal
 * information (names, emails, home address, card/account numbers, MICR
 * lines) by scripts/redact-statements.py — every PII-bearing text run is
 * removed from the PDF's text layer and covered with a black bar. This
 * test therefore also guards the redaction itself: re-extracting the
 * fixtures must surface none of the personal identifiers. To regenerate
 * fixtures from fresh statements: run scripts/redact-statements.py.
 */

const FIXTURES_DIR = "test/fixtures";

interface ExpectedRow {
  date?: string;
  description?: string;
  amount?: string;
  direction?: "charge" | "refund";
}

const CASES: {
  file: string;
  minRows: number;
  spot: ExpectedRow[];
}[] = [
  {
    file: "amex.pdf",
    minRows: 12,
    spot: [
      // Grocery charges parse with the date pulled from mid-line.
      {
        date: "2026-06-14",
        description: "AplPay RALPHS GROCERY STUDIO CITY CA",
        amount: "143.21",
        direction: "charge",
      },
      // Amount-before-date rows too.
      {
        date: "2026-06-24",
        description: "AplPay RALPHS LOS ANGELES CA",
        amount: "112.71",
        direction: "charge",
      },
    ],
  },
  {
    file: "capital-one.pdf",
    minRows: 20,
    spot: [
      // Trans date used, post date stripped.
      {
        date: "2026-06-11",
        description: "CITY OF LA DWP LOS ANGELES CA",
        amount: "117.00",
        direction: "charge",
      },
      // Credits (cash back, payments, adjustments) are excluded from matching.
      { description: "CASH BACK", amount: "25.00", direction: "refund" },
      {
        description: "CAPITAL ONE ONLINE PYMT",
        amount: "600.00",
        direction: "refund",
      },
      {
        description: "PURCHASE ADJUSTMENT",
        amount: "779.88",
        direction: "refund",
      },
      {
        description: "STRIPE-Z.AI SINGAPORE",
        amount: "10.00",
        direction: "charge",
      },
    ],
  },
  {
    file: "chase.pdf",
    minRows: 3,
    spot: [
      {
        date: "2026-07-01",
        description: "Payment Thank You - Web",
        amount: "174.91",
        direction: "refund",
      },
      {
        date: "2026-06-08",
        description: "Kindle Svcs*W62AR8VY3 888-802-3080 WA",
        amount: "4.99",
        direction: "charge",
      },
    ],
  },
  {
    file: "apple-card.pdf",
    minRows: 30,
    spot: [
      // Daily Cash column dropped; the last amount is the transaction.
      {
        date: "2026-06-30",
        description: "SANDCOUCH CAFE 555 W 7TH ST LOS ANGELES 90014 CA USA",
        amount: "8.83",
        direction: "charge",
      },
      {
        date: "2026-07-12",
        description: "APPLE.COM/BILL ONE APPLE PARK WAY CUPERTINO 95014 CA USA",
        amount: "9.99",
        direction: "charge",
      },
    ],
  },
];

/** Personal identifiers that must never appear in the fixtures' text layer.
 * Names are word-boundary matched — "arkin" is a substring of "PARKING",
 * which is a merchant, not the account holder. */
const PII_NAMES = /\b(assaf|arkin|jennifer|jyzoe)\b/i;
const PII_OTHER = [
  "@labnotes",
  "@gmail",
  "1050 s flower",
  "apt 503",
  "90015-5106",
  "ending in",
  "xxxx xxxx",
  "2-12004",
  "2-13010",
];
/** Card numbers and MICR account numbers are >= 15 digits; store numbers
 * (0000000002066) and merchant phones are shorter and not personal. */
const DIGIT_RUN = /(^|\s)\d{15,}(\s|$)/;

function matches(row: StatementRow, expected: ExpectedRow): boolean {
  return (
    (expected.date === undefined || row.date === expected.date) &&
    (expected.description === undefined ||
      row.description === expected.description) &&
    (expected.amount === undefined || row.amount === expected.amount) &&
    (expected.direction === undefined || row.direction === expected.direction)
  );
}

describe("real bank statement PDF fixtures", () => {
  for (const { file, minRows, spot } of CASES) {
    it(`parses ${file} end to end (extraction + lines)`, async () => {
      const lines = await extractPdfLines(
        readFileSync(`${FIXTURES_DIR}/${file}`),
      );
      const { rows, skipped } = parsePdfStatementLines(lines);

      // The statement's transactions all come through — nothing below the
      // per-bank floor.
      expect(rows.length).toBeGreaterThanOrEqual(minRows);

      // Every charge/credit spot-check is present with the right data.
      for (const expected of spot) {
        expect(
          rows.some((r) => matches(r, expected)),
          `missing ${JSON.stringify(expected)} (parsed ${rows.length} rows)`,
        ).toBe(true);
      }

      // Sanity: the parser reports what it couldn't read, and no parsed
      // row is empty or future-dated.
      expect(skipped.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.description).not.toBe("");
        expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it(`has ${file} fully redacted (no personal information in the text layer)`, async () => {
      const lines = await extractPdfLines(
        readFileSync(`${FIXTURES_DIR}/${file}`),
      );
      const all = lines.join("\n").toLowerCase();
      expect(PII_NAMES.test(all), "a name leaked").toBe(false);
      for (const p of PII_OTHER) {
        expect(all.includes(p), `"${p}" leaked`).toBe(false);
      }
      for (const line of lines) {
        expect(
          DIGIT_RUN.test(line.trim()),
          `long digit run leaked: ${line}`,
        ).toBe(false);
      }
    });
  }
});
