import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv, parseStatementUpload } from "~/lib/reconcile.server";

/**
 * Every statement fixture in test/fixtures/statements/ is paired with a
 * companion CSV named `<basename>-statements.csv` that lists every expense
 * (charge) in the statement, one `date,amount,merchant` row per expense.
 * This test parses each statement and asserts it yields exactly the same
 * expenses: the same (date, amount) multiset.
 *
 * Only charges are compared; refunds/payments/credits are not expenses,
 * and banks print them in a summary section the PDF parser deliberately
 * skips. The `merchant` column is documentation for the reader, not an
 * assertion: export formats mangle the name (QBO truncates "CENTRAL GARDENA"
 * to "CENTRALGARDENA", typos like "TOYKO" survive redaction, "GELSON'S" vs
 * "GELSONS" differ), so there is no reliable string/token match across
 * formats. Date + amount is the expense identity reconciliation keys on, so
 * that is what this test enforces.
 */

const FIXTURES_DIR = "test/fixtures/statements";

/**
 * Transactions a bank PDF prints only as a summary total, never as a dated
 * transaction line, so the PDF parser cannot emit them. Amex PDFs show the
 * annual fee only as "Total Fees for this Period $95.00"; the machine
 * exports (CSV/QBO/XLSX) list it as a transaction row.
 */
const PDF_SUMMARY_ONLY: Record<string, Set<string>> = {
  amex: new Set(["2026-07-12|95.00"]),
};

interface ExpectedExpense {
  date: string;
  amount: string;
  merchant: string;
}

function keyOf(date: string, amount: string): string {
  return `${date}|${amount}`;
}

function readExpected(file: string): ExpectedExpense[] {
  const rows = parseCsv(readFileSync(`${FIXTURES_DIR}/${file}`, "utf8"));
  return rows.slice(1).map(([date, amount, merchant]) => ({
    date: date!.trim(),
    amount: amount!.trim(),
    merchant: (merchant ?? "").trim(),
  }));
}

function counts(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/** Statement source files: everything except the companion `-statements.csv`
 * files themselves. */
const statementFiles = readdirSync(FIXTURES_DIR)
  .filter((f) => !f.endsWith("-statements.csv"))
  .sort();

describe("statement fixtures parse to their expected expenses", () => {
  for (const file of statementFiles) {
    it(`parses ${file}`, async () => {
      const basename = file.replace(/\.[^.]+$/, "");
      const companion = `${basename}-statements.csv`;
      expect(
        existsSync(`${FIXTURES_DIR}/${companion}`),
        `${companion} is missing — every statement needs a companion CSV`,
      ).toBe(true);

      const expected = readExpected(companion);
      const buf = readFileSync(`${FIXTURES_DIR}/${file}`);
      const { rows, format } = await parseStatementUpload(file, buf);
      const charges = rows.filter((r) => r.direction === "charge");

      // PDFs can't carry summary-only transactions; everything else must
      // yield the full expense list.
      const omitted =
        format === "pdf"
          ? (PDF_SUMMARY_ONLY[basename] ?? new Set())
          : new Set();
      const expectedCharges = expected.filter(
        (e) => !omitted.has(keyOf(e.date, e.amount)),
      );

      expect(
        counts(charges.map((r) => keyOf(r.date, r.amount))),
        `${file}: parsed charges differ from ${companion}`,
      ).toEqual(counts(expectedCharges.map((e) => keyOf(e.date, e.amount))));
    });
  }
});
