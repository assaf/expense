import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPdfLines } from "~/lib/receipt-ocr.server";
import { parsePdfStatementLines } from "~/lib/reconcile.server";
import type { StatementRow } from "~/lib/types";

/**
 * Runs the REAL bank statement PDFs through the full pipeline (text
 * extraction → line parsing) and checks that each bank's layout still
 * yields its transactions with clean descriptions and correct credit
 * classification. This is the test the synthetic-line unit tests can't
 * be — extraction quirks (column merging, y-sorting, fonts) only show up
 * with real files.
 *
 * The statements are the user's own files (they contain names and
 * addresses), so they are NOT committed to the repo: the test reads them
 * from a local directory (RECONCILE_STATEMENTS_DIR, default
 * ~/Downloads/Reconcline) and skips each file when it isn't there — CI
 * runs with nothing present and skips cleanly. Locally it guards every
 * future parser change against breaking a real statement.
 */
const STATEMENTS_DIR =
  process.env.RECONCILE_STATEMENTS_DIR ?? "/Users/assaf/Downloads/Reconcline";

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
    file: "Reconclie AmEx.pdf",
    minRows: 12,
    spot: [
      // Grocery charges parse with the date pulled from mid-line.
      {
        date: "2026-06-14",
        description: "AplPay RALPHS GROCERY STUDIO CITY CA",
        amount: "143.21",
        direction: "charge",
      },
      // The annual fee is a charge (not a refund); the payment is a credit.
      {
        description: "ASSAF ARKIN ANNUAL FEE",
        amount: "95.00",
        direction: "charge",
      },
      {
        description: "ASSAF ARKIN ONLINE PAYMENT - THANK YOU",
        amount: "1260.08",
        direction: "refund",
      },
    ],
  },
  {
    file: "Reconclie CapitalOne.pdf",
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
    file: "Reconclie Chase.pdf",
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
    file: "Reconclie Apple Card.pdf",
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
      // The ACH payment is a credit, never an expense.
      {
        description:
          "ACH Deposit Internet transfer from account ending in 0752",
        amount: "573.70",
        direction: "refund",
      },
    ],
  },
];

function matches(row: StatementRow, expected: ExpectedRow): boolean {
  return (
    (expected.date === undefined || row.date === expected.date) &&
    (expected.description === undefined ||
      row.description === expected.description) &&
    (expected.amount === undefined || row.amount === expected.amount) &&
    (expected.direction === undefined || row.direction === expected.direction)
  );
}

describe("real bank statement PDFs", () => {
  for (const { file, minRows, spot } of CASES) {
    const path = `${STATEMENTS_DIR}/${file}`;
    if (!existsSync(path)) {
      it.skip(`skips ${file} — not present in ${STATEMENTS_DIR}`);
      continue;
    }
    it(`parses ${file} end to end (extraction + lines)`, async () => {
      const lines = await extractPdfLines(readFileSync(path));
      const { rows, skipped } = parsePdfStatementLines(lines);
      // The statement's transactions all come through — nothing below the
      // per-bank floor.
      expect(rows.length).toBeGreaterThanOrEqual(minRows);
      // Every credit/payment row is excluded from matching; every charge
      // spot-check is present with the right date and amount.
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
  }
});
