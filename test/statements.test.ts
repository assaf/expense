import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import Decimal from "decimal.js";
import { parseCsv } from "~/lib/csv";
import { validateDate } from "~/lib/validation";
import {
  normalizeDate,
  parseMoney,
  parseStatementUpload,
  tokensOf,
  withinAmount,
} from "~/lib/reconcile.server";
import { assertProperty, text, validDate } from "./helpers/property";

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

/**
 * The pure helpers behind statement matching, fuzzed over their own rules.
 * `parseStatementUpload` is not touched here: it is exercised against the
 * real fixtures above, and the module's own transitive import of env.ts is
 * why these live in the unit project (which sets DATABASE_URL) rather than a
 * standalone runner.
 */

const moneyString = fc.stringMatching(/^\d+(\.\d{1,2})?$/);

describe("app/lib/reconcile.server.ts pure helpers", () => {
  it("matches an amount to itself", () => {
    assertProperty([moneyString], (s) => {
      expect(withinAmount(new Decimal(s), new Decimal(s))).toBe(true);
    });
  });

  it("matches exactly the documented tolerance band", () => {
    // Not asserted as symmetric: the tolerance derives from the expense
    // argument alone, so a narrow band above $50 is one-directional.
    assertProperty([moneyString], (s) => {
      const e = new Decimal(s);
      const tol = Decimal.max(e.mul("0.01"), new Decimal("0.50"));
      expect(withinAmount(e.plus(tol), e)).toBe(true);
      expect(withinAmount(e.minus(tol), e)).toBe(true);
      expect(withinAmount(e.plus(tol).plus("0.01"), e)).toBe(false);
      expect(withinAmount(e.minus(tol).minus("0.01"), e)).toBe(false);
    });
  });

  it("parses money exactly when the text carries a digit", () => {
    assertProperty([text(24)], (s) => {
      const parsed = parseMoney(s);
      if (/\d/.test(s)) expect(parsed).not.toBeNull();
      else expect(parsed).toBeNull();
    });
  });

  it("reads a parenthesized amount as negative", () => {
    assertProperty([moneyString], (s) => {
      expect(parseMoney(`(${s})`)!.eq(parseMoney(s)!.neg())).toBe(true);
    });
    expect(parseMoney("$1,234.56")!.eq(parseMoney("1234.56")!)).toBe(true);
  });

  it("normalizes every accepted date form to the same canonical day", () => {
    assertProperty([validDate], (d) => {
      expect(normalizeDate(d)).toBe(d);
      const month = Number(d.slice(5, 7));
      const day = Number(d.slice(8, 10));
      const year = d.slice(0, 4);
      expect(normalizeDate(`${month}/${day}/${year}`)).toBe(d);
      expect(normalizeDate(`${month}/${day}/${year.slice(2)}`)).toBe(d);
      const result = normalizeDate(d);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(validateDate(result!)).toBeNull();
    });
  });

  it("rejects an impossible statement date", () => {
    expect(normalizeDate("2026-02-30")).toBeNull();
    expect(normalizeDate("2026-13-01")).toBeNull();
    expect(normalizeDate("26-01-01")).toBeNull();
  });

  it("emits only clean word tokens", () => {
    assertProperty([text(60)], (t) => {
      for (const token of tokensOf(t)) expect(token).toMatch(/^[a-z0-9]{3,}$/);
    });
  });
});
