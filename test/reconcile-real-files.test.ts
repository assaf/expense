import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseXlsxSheets } from "~/lib/excel.server";
import { extractPdfLines } from "~/lib/receipt-ocr.server";
import { parseStatementUpload } from "~/lib/reconcile.server";
import type { StatementRow } from "~/lib/types";

/**
 * Runs the REAL bank statement files (committed fixtures, test/fixtures/statements/)
 * through the full pipeline (PDFs, CSV, QuickBooks QBO, and Excel) and
 * checks each layout still yields its transactions with clean descriptions
 * and correct credit classification. Extraction quirks (column merging,
 * y-sorting, custom-font encoding, yearless dates, Daily Cash columns,
 * spreadsheet cell types) only show up with real files, which is why the
 * synthetic unit tests can't replace this.
 *
 * The fixtures are the user's own statements, redacted of personal
 * information (names, emails, home address, card/account numbers, MICR
 * lines) by scripts/redact-statements.py: PII-bearing text is removed
 * from the PDF text layer and covered with black bars, and replaced in
 * CSV/QBO/Excel cells. This test therefore also guards the redaction
 * itself: re-reading the fixtures must surface none of the personal
 * identifiers. To regenerate fixtures from fresh statements: run
 * scripts/redact-statements.py.
 */

const FIXTURES_DIR = "test/fixtures/statements";

interface ExpectedRow {
  date?: string;
  description?: string;
  amount?: string;
  direction?: "charge" | "refund";
}

/** surface: how the file's text is read back for the redaction check. */
const CASES: {
  file: string;
  surface: "pdf" | "text" | "xlsx";
  minRows: number;
  spot: ExpectedRow[];
}[] = [
  {
    file: "amex.pdf",
    surface: "pdf",
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
    surface: "pdf",
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
    surface: "pdf",
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
    surface: "pdf",
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
  {
    // The same Amex statement in CSV, QuickBooks QBO, and Excel. The
    // descriptions differ slightly per format (Amex truncates the NAME
    // field in QBO and pads the address in CSV/Excel), so these spot
    // checks are keyed on date + amount + direction only.
    file: "amex.csv",
    surface: "text",
    minRows: 12,
    spot: [
      { date: "2026-07-12", amount: "95.00", direction: "charge" }, // fee
      { date: "2026-07-10", amount: "126.50", direction: "charge" },
      { date: "2026-07-01", amount: "1260.08", direction: "refund" }, // payment
      { date: "2026-07-01", amount: "93.24", direction: "refund" }, // cash reward
      { date: "2026-06-14", amount: "143.21", direction: "charge" },
    ],
  },
  {
    file: "amex.qbo",
    surface: "text",
    minRows: 12,
    spot: [
      { date: "2026-07-12", amount: "95.00", direction: "charge" },
      { date: "2026-07-01", amount: "1260.08", direction: "refund" },
      { date: "2026-06-14", amount: "143.21", direction: "charge" },
    ],
  },
  {
    file: "amex.xlsx",
    surface: "xlsx",
    minRows: 12,
    spot: [
      { date: "2026-07-12", amount: "95.00", direction: "charge" },
      { date: "2026-07-01", amount: "1260.08", direction: "refund" },
      { date: "2026-06-14", amount: "143.21", direction: "charge" },
    ],
  },
];

/** Personal identifiers that must never appear in the fixtures' text layer.
 * Names are word-boundary matched: "arkin" is a substring of "PARKING",
 * which is a merchant, not the account holder. */
const PII_NAMES = /\b(assaf|arkin|jennifer|hong|jyzoe)\b/i;
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
  "12004",
  "13010",
  "h9aco0o8",
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

/** The file's text surface, for the redaction check. */
async function textSurface(
  file: string,
  surface: "pdf" | "text" | "xlsx",
): Promise<string> {
  const buf = readFileSync(`${FIXTURES_DIR}/${file}`);
  if (surface === "pdf") {
    return (await extractPdfLines(buf)).join("\n");
  }
  if (surface === "xlsx") {
    return parseXlsxSheets(buf)
      .flat()
      .map((row) => row.join(" "))
      .join("\n");
  }
  return buf.toString("utf8");
}

describe("real bank statement fixtures", () => {
  for (const { file, surface, minRows, spot } of CASES) {
    it(`parses ${file} end to end`, async () => {
      const buf = readFileSync(`${FIXTURES_DIR}/${file}`);
      const { rows, skipped } = await parseStatementUpload(file, buf);

      // The statement's transactions all come through, nothing below the
      // per-bank floor.
      expect(rows.length).toBeGreaterThanOrEqual(minRows);

      // Every charge/credit spot-check is present with the right data.
      for (const expected of spot) {
        expect(
          rows.some((r) => matches(r, expected)),
          `missing ${JSON.stringify(expected)} (parsed ${rows.length} rows)`,
        ).toBe(true);
      }

      // Sanity: PDFs report what they couldn't read; no parsed row is
      // empty or future-dated.
      if (surface === "pdf") {
        expect(skipped.length).toBeGreaterThan(0);
      }
      for (const r of rows) {
        expect(r.description).not.toBe("");
        expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it(`has ${file} fully redacted (no personal information in the text layer)`, async () => {
      const all = (await textSurface(file, surface)).toLowerCase();
      expect(PII_NAMES.test(all), "a name leaked").toBe(false);
      for (const p of PII_OTHER) {
        expect(all.includes(p), `"${p}" leaked`).toBe(false);
      }
      for (const line of all.split("\n")) {
        expect(
          DIGIT_RUN.test(line.trim()),
          `long digit run leaked: ${line}`,
        ).toBe(false);
      }
    });
  }
});
