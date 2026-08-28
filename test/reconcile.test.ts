import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { strToU8, zipSync } from "fflate";
import {
  DATE_TOLERANCE_DAYS,
  matchStatementRows,
  normalizeDate,
  parseCsv,
  parseMoney,
  parseOfxStatement,
  parsePdfStatementLines,
  parseStatementCsv,
  parseStatementText,
  parseStatementUpload,
  reconcileForMcp,
  sniffStatementText,
  tokensOf,
  withinAmount,
} from "~/lib/reconcile.server";
import {
  completeReconciliationRun,
  createReconciliationRun,
  discardReconciliationRun,
  findReconciliationRunByHash,
  listReconciliationRuns,
  readReconciliationRun,
  updateReconciliationDecision,
} from "~/lib/db/reconcile";
import { readExpenses } from "~/lib/db/expenses";
import type {
  Expense,
  MileageExpense,
  ReceiptExpense,
  StatementRow,
} from "~/lib/types";
import {
  OTHER_ACCOUNT_ID,
  TEST_ACCOUNT_ID,
  testPrisma,
} from "./helpers/seedTestData";
import { ulid } from "ulid";

// --- Fixtures --------------------------------------------------------------

const makeReceipt = (
  overrides: Partial<ReceiptExpense> = {},
): ReceiptExpense => ({
  id: ulid(),
  type: "receipt",
  date: "2026-01-15",
  report: "2026 Test",
  category: "Testing",
  description: "",
  amount: "42.50",
  merchant: "Test Store",
  imageFile: "receipt.jpg",
  imageMime: "image/jpeg",
  originalName: "receipt.jpg",
  imageSha256: "",
  currency: "USD",
  originalAmount: "",
  fxRate: "",
  reconciledAt: "",
  createdAt: "2026-01-16T00:00:00.000Z",
  updatedAt: "2026-01-16T00:00:00.000Z",
  ...overrides,
});

const makeMileage = (
  overrides: Partial<MileageExpense> = {},
): MileageExpense => ({
  id: ulid(),
  type: "mileage",
  mileageType: "business",
  date: "2026-03-10",
  report: "2026 Test",
  category: "Travel",
  description: "",
  amount: "22.40",
  locations: [
    { address: "Home", lat: 34.05, lng: -118.24 },
    { address: "Client Office", lat: 34.06, lng: -118.25 },
  ],
  distanceMiles: "32.00",
  route: { coords: [], returnCoords: [] },
  reconciledAt: "",
  createdAt: "2026-03-11T00:00:00.000Z",
  updatedAt: "2026-03-11T00:00:00.000Z",
  ...overrides,
});

const CSV = [
  "date,description,amount",
  "2026-01-15,TEST STORE PURCHASE,42.50",
  "2026-02-20,OFFICEMAX PRINTER PAPER,15.99",
  "2026-07-01,UNKNOWN COFFEE SHOP,9.99",
].join("\n");

// --- Parsing ---------------------------------------------------------------

/** Build a minimal .xlsx workbook from cell rows (fflate zip + minimal
 * OOXML). Number-like cells are stored as numeric cells, everything else
 * as shared strings, matching what bank exports produce. */
function makeXlsx(rows: string[][]): Buffer {
  const shared: string[] = [];
  const sharedIdx = new Map<string, number>();
  const idx = (s: string) => {
    if (!sharedIdx.has(s)) {
      sharedIdx.set(s, shared.length);
      shared.push(s);
    }
    return sharedIdx.get(s)!;
  };
  const col = (i: number) => {
    let out = "";
    i++;
    while (i > 0) {
      out = String.fromCharCode(65 + ((i - 1) % 26)) + out;
      i = Math.floor((i - 1) / 26);
    }
    return out;
  };
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
${rows
  .map(
    (row, r) =>
      `<row r="${r + 1}">${row
        .map((val, c) => {
          const ref = `${col(c)}${r + 1}`;
          return /^-?\d+(\.\d+)?$/.test(val.trim())
            ? `<c r="${ref}" t="n"><v>${val.trim()}</v></c>`
            : `<c r="${ref}" t="s"><v>${idx(val)}</v></c>`;
        })
        .join("")}</row>`,
  )
  .join("\n")}
</sheetData></worksheet>`;
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">
${shared.map((s) => `<si><t>${escape(s)}</t></si>`).join("")}
</sst>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  const packageRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(packageRels),
      "xl/workbook.xml": strToU8(workbookXml),
      "xl/_rels/workbook.xml.rels": strToU8(relsXml),
      "xl/sharedStrings.xml": strToU8(sharedXml),
      "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    }),
  );
}

describe("statement parsing", () => {
  it("parses RFC-4180-ish CSV cells (quotes, doubled quotes)", () => {
    expect(
      parseCsv('date,desc\n1/1/2026,"paid, in cash"\n2/1/2026,"said ""hi"""'),
    ).toEqual([
      ["date", "desc"],
      ["1/1/2026", "paid, in cash"],
      ["2/1/2026", 'said "hi"'],
    ]);
  });

  it("parses a CSV with a header row and normalizes dates/amounts", () => {
    const { rows, skipped } = parseStatementCsv(CSV);
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      date: "2026-01-15",
      description: "TEST STORE PURCHASE",
      amount: "42.50",
      direction: "charge",
      source: "csv",
    });
    expect(rows[2]!.amount).toBe("9.99");
  });

  it("accepts a headerless date,description,amount CSV", () => {
    const { rows } = parseStatementCsv(
      "1/15/2026,TEST STORE,42.50\n2/20/2026,OFFICEMAX,$15.99",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: "2026-01-15", amount: "42.50" });
    expect(rows[1]).toMatchObject({ date: "2026-02-20", amount: "15.99" });
  });

  it("classifies signed CSVs: negative = charge, positive = refund", () => {
    // Chase-style: purchases are negative, refunds positive, Type column present.
    const { rows } = parseStatementCsv(
      [
        "Transaction Date,Posting Date,Description,Type,Amount",
        "01/15/2026,01/16/2026,TEST STORE PURCHASE,Sale,-42.50",
        "01/20/2026,01/20/2026,STARBUCKS REFUND,Refund,12.50",
        "01/21/2026,01/21/2026,PAYMENT - THANK YOU,Payment,500.00",
      ].join("\n"),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ amount: "42.50", direction: "charge" });
    expect(rows[1]).toMatchObject({ amount: "12.50", direction: "refund" });
    expect(rows[2]).toMatchObject({ amount: "500.00", direction: "refund" });
  });

  it("uses the earliest date column when a CSV carries trans + posting dates", () => {
    // Chase-style with Posting Date listed first; the transaction date is
    // still the row date (posting is a settlement artifact a day later).
    const { rows, skipped } = parseStatementCsv(
      [
        "Posting Date,Transaction Date,Description,Type,Amount",
        "01/16/2026,01/15/2026,TEST STORE PURCHASE,Sale,-42.50",
        "01/20/2026,01/20/2026,STARBUCKS REFUND,Refund,12.50",
      ].join("\n"),
    );
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: "2026-01-15",
      description: "TEST STORE PURCHASE",
      direction: "charge",
    });
    expect(rows[1]).toMatchObject({ date: "2026-01-20", direction: "refund" });
  });

  it("handles a Debit/Credit column split (Citi-style)", () => {
    const { rows } = parseStatementCsv(
      [
        "Date,Description,Debit,Credit",
        "01/15/2026,TEST STORE,42.50,",
        "01/20/2026,STARBUCKS REFUND,,12.50",
      ].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ amount: "42.50", direction: "charge" });
    expect(rows[1]).toMatchObject({ amount: "12.50", direction: "refund" });
  });

  it("parses parenthesized negative amounts", () => {
    expect(parseMoney("(12.34)")?.toFixed(2)).toBe("-12.34");
    expect(parseMoney("$1,234.56")?.toFixed(2)).toBe("1234.56");
  });

  it("normalizes US, ISO, and named dates", () => {
    expect(normalizeDate("08/03/2026")).toBe("2026-08-03");
    expect(normalizeDate("8/3/26")).toBe("2026-08-03");
    expect(normalizeDate("2026-08-03")).toBe("2026-08-03");
    expect(normalizeDate("Aug 3 2026")).toBe("2026-08-03");
    expect(normalizeDate("Aug 3, 2026")).toBe("2026-08-03");
    expect(normalizeDate("3 Aug 2026")).toBe("2026-08-03");
    expect(normalizeDate("not a date")).toBeNull();
  });

  it("parses an OFX/QFX statement with FITID and sign-based direction", () => {
    const ofx = [
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "VERSION:102",
      "",
      "<OFX>",
      "<CREDITCARDMSGSRSV1>",
      "<CCSTMTTRNRS>",
      "<CCSTMTRS>",
      "<CURDEF>USD</CURDEF>",
      "<BANKTRANLIST>",
      "<STMTTRN>",
      "<TRNTYPE>DEBIT</TRNTYPE>",
      "<DTPOSTED>20260803120000.000[-8:PST]</DTPOSTED>",
      "<TRNAMT>-12.50</TRNAMT>",
      "<FITID>20260803120000</FITID>",
      "<NAME>STARBUCKS STORE 00123</NAME>",
      "<MEMO>SEATTLE WA</MEMO>",
      "</STMTTRN>",
      "<STMTTRN>",
      "<TRNTYPE>CREDIT</TRNTYPE>",
      "<DTPOSTED>20260805</DTPOSTED>",
      "<TRNAMT>9.99</TRNAMT>",
      "<FITID>20260805000000</FITID>",
      "<NAME>AMAZON REFUND</NAME>",
      "</STMTTRN>",
      "</BANKTRANLIST>",
      "</CCSTMTRS>",
      "</CCSTMTTRNRS>",
      "</CREDITCARDMSGSRSV1>",
      "</OFX>",
    ].join("\n");
    expect(sniffStatementText(ofx)).toBe("ofx");
    const { rows, skipped } = parseOfxStatement(ofx);
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: "2026-08-03",
      amount: "12.50",
      direction: "charge",
      fitId: "20260803120000",
      description: "STARBUCKS STORE 00123",
      source: "ofx",
    });
    expect(rows[1]).toMatchObject({
      direction: "refund",
      fitId: "20260805000000",
    });
  });

  it("uses the earlier of DTUSER / DTPOSTED in OFX", () => {
    // Chase QFX carries both the user's transaction date and the posting
    // date, and the transaction date is the expense date.
    const ofx = [
      "<OFX>",
      "<CREDITCARDMSGSRSV1>",
      "<CCSTMTTRNRS>",
      "<CCSTMTRS>",
      "<BANKTRANLIST>",
      "<STMTTRN>",
      "<TRNTYPE>DEBIT</TRNTYPE>",
      "<DTUSER>20260707120000.000[-7:MST]</DTUSER>",
      "<DTPOSTED>20260708120000.000[-7:MST]</DTPOSTED>",
      "<TRNAMT>-25.00</TRNAMT>",
      "<FITID>ABC123</FITID>",
      "<NAME>AMAZON MKTPLACE</NAME>",
      "</STMTTRN>",
      "</BANKTRANLIST>",
      "</CCSTMTRS>",
      "</CCSTMTTRNRS>",
      "</CREDITCARDMSGSRSV1>",
      "</OFX>",
    ].join("\n");
    const { rows } = parseOfxStatement(ofx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-07-07" });
  });

  it("parses PDF statement lines: one-line rows and multi-line groups", () => {
    const lines = [
      "Statement of Account",
      "Aug 3 2026 STARBUCKS STORE #12345 $12.50",
      "Aug 4 2026",
      "WHOLE FOODS MARKET",
      "$84.20",
      "Aug 5 2026 AMAZON MKTPLACE 42.00",
      "Page 1 of 1",
    ];
    const { rows, skipped } = parsePdfStatementLines(lines);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      date: "2026-08-03",
      description: "STARBUCKS STORE #12345",
      amount: "12.50",
      direction: "charge",
      source: "pdf",
    });
    expect(rows[1]).toMatchObject({
      date: "2026-08-04",
      description: "WHOLE FOODS MARKET",
      amount: "84.20",
    });
    expect(rows[2]).toMatchObject({ date: "2026-08-05", amount: "42.00" });
    // The statement chrome lines are quiet (not transactions, not skipped).
    expect(skipped).toEqual([]);
  });

  it("sniffs CSV vs OFX text", () => {
    expect(sniffStatementText("date,description,amount\n1/1/2026,a,1.00")).toBe(
      "csv",
    );
    expect(sniffStatementText("<OFX>")).toBe("ofx");
    expect(sniffStatementText("OFXHEADER:100\nDATA:OFXSGML")).toBe("ofx");
    expect(parseStatementText(CSV, "csv").rows.length).toBe(3);
  });

  it("detects the file format from bytes and parses a PDF upload", async () => {
    const pdf = await import("pdfkit").then(
      async (mod) =>
        await new Promise<Buffer>((resolve, reject) => {
          const doc = new mod.default({ size: "LETTER" });
          const chunks: Buffer[] = [];
          doc.on("data", (c: Buffer) => chunks.push(c));
          doc.on("end", () => resolve(Buffer.concat(chunks)));
          doc.on("error", reject);
          doc.fontSize(11).text("Aug 3 2026 STARBUCKS STORE 12.50");
          doc.text("Aug 4 2026 WHOLE FOODS 84.20");
          doc.end();
        }),
    );
    const { rows, format } = await parseStatementUpload("statement.pdf", pdf);
    expect(format).toBe("pdf");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.amount).toBe("12.50");
  });

  it("parses bank PDF rows with the date and amount anywhere on the line (Amex layout)", () => {
    const lines = [
      "AplPay RALPHS GROCERY STUDIO CITY CA 06/14/26 $143.21",
      "AplPay RALPHS LOS ANGELES CA $112.71 06/24/26",
      "YOUR CASH REWARD/REFUND IS 07/01/26* ASSAF ARKIN -$93.24",
      "07/12/26 ASSAF ARKIN ANNUAL FEE $95.00",
      "07/01/26* ASSAF ARKIN ONLINE PAYMENT - THANK YOU -$1,260.08",
    ];
    const { rows } = parsePdfStatementLines(lines);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      date: "2026-06-14",
      description: "AplPay RALPHS GROCERY STUDIO CITY CA",
      amount: "143.21",
      direction: "charge",
    });
    expect(rows[1]).toMatchObject({ date: "2026-06-24", amount: "112.71" });
    // Credits carry refund keywords; the fee is a charge; payments are
    // refunds. PDF signs vary by bank, so keywords decide.
    expect(rows[2]).toMatchObject({ direction: "refund" });
    expect(rows[3]).toMatchObject({
      date: "2026-07-12",
      description: "ASSAF ARKIN ANNUAL FEE",
      amount: "95.00",
      direction: "charge",
    });
    expect(rows[4]).toMatchObject({ direction: "refund" });
  });

  it("parses Capital One rows: yearless dates, trans+post dates, sign-spaced amounts", () => {
    const lines = [
      "Jun 12, 2026 - Jul 12, 2026 | 31 days in Billing Cycle",
      "Jun 13 Jun 13 CASH BACK - $25.00",
      "Jun 25 Jun 27 PURCHASE ADJUSTMENT - $779.88",
      "Jul 6 Jul 6 CAPITAL ONE ONLINE PYMT - $600.00",
      "Jun 11 Jun 12 CITY OF LA DWP LOS ANGELES CA $117.00",
      "Jun 12 Jun 15 PAYPAL *SHENDUQRWEA 4029357733 HKG $10.60",
    ];
    const { rows } = parsePdfStatementLines(lines);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      date: "2026-06-13",
      description: "CASH BACK",
      amount: "25.00",
      direction: "refund",
    });
    expect(rows[1]).toMatchObject({
      date: "2026-06-25",
      description: "PURCHASE ADJUSTMENT",
      amount: "779.88",
      direction: "refund",
    });
    expect(rows[2]).toMatchObject({
      date: "2026-07-06",
      description: "CAPITAL ONE ONLINE PYMT",
      amount: "600.00",
      direction: "refund",
    });
    // The trans date is used; the post date is stripped from the description.
    expect(rows[3]).toMatchObject({
      date: "2026-06-11",
      description: "CITY OF LA DWP LOS ANGELES CA",
      amount: "117.00",
      direction: "charge",
    });
    expect(rows[4]).toMatchObject({
      date: "2026-06-12",
      description: "PAYPAL *SHENDUQRWEA 4029357733 HKG",
      amount: "10.60",
      direction: "charge",
    });
  });

  it("picks the earliest date when a PDF row lists posting before transaction", () => {
    const lines = [
      "Jun 12, 2026 - Jul 12, 2026 | 31 days in Billing Cycle",
      "Jul 8 Jul 7 AMAZON MKTPLACE $42.50",
      "Jul 12 Jul 12 CAPITAL ONE ONLINE PYMT - $600.00",
    ];
    const { rows } = parsePdfStatementLines(lines);
    expect(rows).toHaveLength(2);
    // Posting date printed first, yet the transaction date still wins.
    expect(rows[0]).toMatchObject({
      date: "2026-07-07",
      description: "AMAZON MKTPLACE",
      direction: "charge",
    });
    expect(rows[1]).toMatchObject({
      date: "2026-07-12",
      direction: "refund",
    });
  });

  it("resolves yearless dates across a year-crossing billing cycle", () => {
    const lines = [
      "Nov 25, 2026 - Jan 5, 2027 | 42 days in Billing Cycle",
      "Dec 20 Dec 21 STRIPE-Z.AI SINGAPORE $10.00",
      "Jan 3 Jan 4 AMAZON MKTPLACE $42.50",
    ];
    const { rows } = parsePdfStatementLines(lines);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: "2026-12-20" });
    expect(rows[1]).toMatchObject({ date: "2027-01-03" });
  });

  it("ignores summary-page column-merge noise that carries a date and amount", () => {
    const lines = [
      "on the statement closing date when Payments - $2,739.84 Aug 06, 2026",
      "Available Credit (as of Jul 12, 2026) $34,667.86",
    ];
    const { rows } = parsePdfStatementLines(lines);
    expect(rows).toHaveLength(0);
  });

  it("parses Chase rows: numeric yearless dates from a numeric cycle header", () => {
    const lines = [
      "Opening/Closing Date 06/08/26 - 07/07/26",
      "07/01 Payment Thank You - Web -174.91",
      "06/08 Kindle Svcs*W62AR8VY3 888-802-3080 WA 4.99",
      "07/02 A.Z. Pharmacy LLC Amzn.com/bill WA 7.43",
    ];
    const { rows } = parsePdfStatementLines(lines);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      date: "2026-07-01",
      description: "Payment Thank You - Web",
      amount: "174.91",
      direction: "refund",
    });
    expect(rows[1]).toMatchObject({
      date: "2026-06-08",
      description: "Kindle Svcs*W62AR8VY3 888-802-3080 WA",
      amount: "4.99",
      direction: "charge",
    });
    expect(rows[2]).toMatchObject({ date: "2026-07-02", amount: "7.43" });
  });

  it("rejects impossible dates (month 26, Feb 30) instead of guessing", () => {
    expect(normalizeDate("26/07/07")).toBeNull();
    expect(normalizeDate("02/30/2026")).toBeNull();
    expect(normalizeDate("13/01/2026")).toBeNull();
    expect(normalizeDate("2026-13-01")).toBeNull();
  });

  it("parses Apple Card rows: Daily Cash column, ACH payment, em-dash cycle", () => {
    const lines = [
      "Jennifer Hong, jyzoe.hong@gmail.com Jul 1 — Jul 31, 2026",
      "06/30/2026 SANDCOUCH CAFE 555 W 7TH ST LOS ANGELES 90014 CA USA 2% $0.18 $8.83",
      "Jul 5 Jul 6 TEST MERCHANT $10.00",
      "-$573.70 ACH Deposit Internet transfer from account ending in 0752 07/31/2026",
    ];
    const { rows } = parsePdfStatementLines(lines);
    expect(rows).toHaveLength(3);
    // The Daily Cash amount is dropped; the last amount is the transaction.
    expect(rows[0]).toMatchObject({
      date: "2026-06-30",
      description: "SANDCOUCH CAFE 555 W 7TH ST LOS ANGELES 90014 CA USA",
      amount: "8.83",
      direction: "charge",
    });
    // Yearless date resolved against the em-dash cycle header.
    expect(rows[1]).toMatchObject({
      date: "2026-07-05",
      description: "TEST MERCHANT",
      amount: "10.00",
      direction: "charge",
    });
    // The ACH payment is a credit, never an expense.
    expect(rows[2]).toMatchObject({
      date: "2026-07-31",
      description: "ACH Deposit Internet transfer from account ending in 0752",
      amount: "573.70",
      direction: "refund",
    });
  });

  it("classifies negative PDF amounts without keywords as credits", () => {
    const { rows } = parsePdfStatementLines([
      "Jun 25 Jun 26 VERCEL INC. COVINA CA - $0.07",
    ]);
    expect(rows[0]).toMatchObject({ direction: "refund" });
  });

  it("rejects summary/table lines with several amounts or dates", () => {
    const lines = [
      "Purchases 06/01/2023 17.49% (v) $0.00 $0.00",
      "New Balance $1,102.92",
      "Total New Charges $1,007.92",
    ];
    const { rows } = parsePdfStatementLines(lines);
    expect(rows).toHaveLength(0);
  });

  it("tokenizes merchant words for overlap scoring", () => {
    expect(tokensOf("STARBUCKS STORE #12345")).toEqual(
      new Set(["starbucks", "store", "12345"]),
    );
  });
});

// --- Matching --------------------------------------------------------------

const stubRows = (): StatementRow[] => [
  {
    index: 0,
    date: "2026-01-15",
    description: "TEST STORE PURCHASE",
    amount: "42.50",
    direction: "charge",
    source: "csv",
    raw: "2026-01-15,TEST STORE PURCHASE,42.50",
  },
];

describe("statement matching", () => {
  it("matches exact date + amount + merchant token overlap as high confidence", () => {
    const matches = matchStatementRows(stubRows(), [makeReceipt()]);
    expect(matches[0]!.status).toBe("matched");
    if (matches[0]!.status === "matched") {
      expect(matches[0]!.confidence).toBe("high");
      expect(matches[0]!.candidate.merchant).toBe("Test Store");
    }
  });

  it("matches compound merchants across word boundaries (OfficeMax ↔ OFFICE MAX)", () => {
    const cases: [string, string][] = [
      // Two words split one way, one word the other.
      ["OFFICE MAX", "OfficeMax"],
      // Both multi-word, one side concatenated.
      ["WHOLE FOODS MARKET", "WholeFoodsMarket"],
      // Hyphenated on the statement, one word on the receipt.
      ["CAR WASH - EXPRESS", "CarWashExpress"],
      // Merchant side split, statement side concatenated.
      ["OFFICEMAX", "Office Max"],
    ];
    for (const [desc, merchant] of cases) {
      const row: StatementRow = { ...stubRows()[0]!, description: desc };
      const matches = matchStatementRows([row], [makeReceipt({ merchant })]);
      expect(matches[0]!.status).toBe("matched");
      if (matches[0]!.status === "matched") {
        expect(matches[0]!.confidence).toBe("high");
      }
    }
  });

  it("keeps genuinely different merchants apart (no fuzzy substring match)", () => {
    // "Star" is a prefix of "Starbucks"; a fuzzy metric would wrongly
    // link them; the exact-token/concatenation match must not.
    const row: StatementRow = {
      ...stubRows()[0]!,
      description: "STARBUCKS STORE #12345",
    };
    const matches = matchStatementRows(
      [row],
      [makeReceipt({ merchant: "Star Market" })],
    );
    expect(matches[0]!.status).toBe("review");
    if (matches[0]!.status === "review") {
      expect(matches[0]!.reasons.join(" ")).toMatch(/merchant name differs/);
    }
  });

  it("sends a same-date same-amount row with a different merchant to review", () => {
    const matches = matchStatementRows(stubRows(), [
      makeReceipt({ merchant: "Something Else" }),
    ]);
    expect(matches[0]!.status).toBe("review");
    if (matches[0]!.status === "review") {
      expect(matches[0]!.reasons.join(" ")).toMatch(/merchant name differs/);
      expect(matches[0]!.best).not.toBeNull();
    }
  });

  it("tolerates a 1-day date drift (posting vs purchase date) but reviews it", () => {
    const matches = matchStatementRows(
      [{ ...stubRows()[0]!, date: "2026-01-16" }],
      [makeReceipt()],
    );
    expect(matches[0]!.status).toBe("review");
  });

  it("refuses to auto-match a refund against a purchase", () => {
    const refundRow: StatementRow = {
      ...stubRows()[0]!,
      description: "STARBUCKS REFUND",
      direction: "refund",
      amount: "42.50",
    };
    const matches = matchStatementRows([refundRow], [makeReceipt()]);
    expect(matches[0]!.status).toBe("unmatched");
  });

  it("flags a candidate claimed by two statement lines for review", () => {
    const rows: StatementRow[] = [
      stubRows()[0]!,
      { ...stubRows()[0]!, index: 1, raw: "second" },
    ];
    const matches = matchStatementRows(rows, [makeReceipt()]);
    expect(matches[0]!.status).toBe("review");
    expect(matches[1]!.status).toBe("review");
    if (matches[0]!.status === "review") {
      expect(matches[0]!.best).toBeNull(); // no preselection under conflict
    }
  });

  it("excludes already-reconciled expenses from candidates", () => {
    const matches = matchStatementRows(stubRows(), [
      makeReceipt({ reconciledAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(matches[0]!.status).toBe("unmatched");
  });

  it("never matches mileage expenses (they aren't card transactions)", () => {
    const matches = matchStatementRows(stubRows(), [makeMileage()]);
    expect(matches[0]!.status).toBe("unmatched");
  });

  it("orders the MCP statement lines newest first (matches the web UI)", () => {
    const csv = [
      "date,description,amount",
      "2026-01-15,OLD STORE PURCHASE,42.50",
      "2026-03-10,NEW STORE PURCHASE,11.00",
      "2026-02-05,MID STORE PURCHASE,22.00",
    ].join("\n");
    const result = reconcileForMcp(csv, []) as {
      matchedPairs: { date: string }[];
      unmatchedLines: { date: string; line: number }[];
      needsReview: { date: string }[];
    };
    // No expenses → every line lands in unmatchedLines, in statement order.
    expect(result.unmatchedLines.map((l) => l.date)).toEqual([
      "2026-03-10",
      "2026-02-05",
      "2026-01-15",
    ]);
    // `line` still points at each row's original position in the file
    // (1-based), independent of the display order.
    expect(result.unmatchedLines.map((l) => l.line)).toEqual([2, 3, 1]);
    expect(result.matchedPairs).toEqual([]);
    expect(result.needsReview).toEqual([]);
  });

  it("applies the amount tolerance: within $0.50/1% yes, tips no", () => {
    const expenses: Expense[] = [
      makeReceipt({ id: "a", amount: "25.00", merchant: "Blue Bottle" }),
      makeReceipt({ id: "b", amount: "28.00", merchant: "Blue Bottle" }),
    ];
    const rows: StatementRow[] = [
      {
        ...stubRows()[0]!,
        index: 0,
        amount: "25.40",
        description: "BLUE BOTTLE",
        raw: "1",
      },
      {
        ...stubRows()[0]!,
        index: 1,
        amount: "28.00",
        description: "BLUE BOTTLE",
        raw: "2",
      },
    ];
    const matches = matchStatementRows(rows, expenses);
    expect(matches[0]!.status).toBe("review"); // 25.40 vs 25.00 within $0.50
    expect(matches[1]!.status).toBe("matched"); // exact 28.00
  });

  it("keeps the tolerance constants sane", () => {
    expect(DATE_TOLERANCE_DAYS).toBe(2);
    expect(withinAmount(new Decimal("10.25"), new Decimal("10.00"))).toBe(true);
    expect(withinAmount(new Decimal("9.25"), new Decimal("10.00"))).toBe(false);
  });
});

// --- Store ----------------------------------------------------------------

/** Parse a tiny CSV and create a draft run for the test account. */
async function draftRun(csv = CSV, accountId = TEST_ACCOUNT_ID) {
  const parsed = parseStatementCsv(csv);
  const expenses = await readExpenses(accountId);
  const matches = matchStatementRows(parsed.rows, expenses);
  return createReconciliationRun(accountId, {
    id: ulid(),
    fileName: "statement.csv",
    fileHash: `hash-${ulid()}`,
    rows: parsed.rows,
    matches,
    skipped: parsed.skipped,
  });
}

describe("reconciliation store", () => {
  it("creates a draft run and reads it back with parsed rows + matches", async () => {
    const run = await draftRun();
    const read = await readReconciliationRun(TEST_ACCOUNT_ID, run.id);
    expect(read).toBeDefined();
    expect(read!.status).toBe("draft");
    expect(read!.data.rows).toHaveLength(3);
    // The Test Store row matched the seeded expense; the coffee row didn't.
    const matched = read!.data.matches[0]!;
    expect(matched.status).toBe("matched");
    expect(read!.data.decisions).toEqual({});
  });

  it("records and clears per-row decisions", async () => {
    const run = await draftRun();
    const ok = await updateReconciliationDecision(TEST_ACCOUNT_ID, run.id, 2, {
      kind: "match",
      expenseId: "whatever",
    });
    expect(ok).toBe(true);
    let read = await readReconciliationRun(TEST_ACCOUNT_ID, run.id);
    expect(read!.data.decisions["2"]).toEqual({
      kind: "match",
      expenseId: "whatever",
    });
    await updateReconciliationDecision(TEST_ACCOUNT_ID, run.id, 2, null);
    read = await readReconciliationRun(TEST_ACCOUNT_ID, run.id);
    expect(read!.data.decisions["2"]).toBeUndefined();
  });

  it("completes: marks matched expenses reconciled and creates new ones", async () => {
    const run = await draftRun();
    // Row 2 (UNKNOWN COFFEE SHOP 9.99) → add as a new expense.
    await updateReconciliationDecision(TEST_ACCOUNT_ID, run.id, 2, {
      kind: "new",
      draft: {
        date: "2026-07-01",
        merchant: "Unknown Coffee Shop",
        amount: "9.99",
        report: "2026 Test",
        category: "Testing",
        description: "",
      },
    });
    const res = await completeReconciliationRun(TEST_ACCOUNT_ID, run.id);
    expect(res.error).toBeNull();
    // Two seeded expenses match this CSV: Test Store and OfficeMax.
    expect(res.result!.matched).toBe(2);
    expect(res.result!.created).toBe(1); // Coffee shop
    expect(res.result!.errors).toEqual([]);

    const done = await readReconciliationRun(TEST_ACCOUNT_ID, run.id);
    expect(done!.status).toBe("completed");
    expect(done!.completedAt).toBeTruthy();
    expect(done!.matchedCount).toBe(2);
    expect(done!.createdCount).toBe(1);

    // The seeded Test Store expense is now reconciled.
    const rows = await testPrisma.expense.findMany({
      where: { accountId: TEST_ACCOUNT_ID, merchant: "Test Store" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reconciledAt).toBeTruthy();
    expect(rows[0]!.reconciledInRunId).toBe(run.id);

    // The new expense exists, is itself reconciled, and has a rendered image.
    const created = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, merchant: "Unknown Coffee Shop" },
    });
    expect(created).toBeTruthy();
    expect(created!.reconciledAt).toBeTruthy();
    expect(created!.reconciledInRunId).toBe(run.id);
    expect(created!.imageFile).toBeTruthy();
    const blob = await testPrisma.imageBlob.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, key: created!.imageFile },
    });
    expect(blob).toBeTruthy();
    // saveImage's normalizer re-encodes the rendered receipt as JPEG.
    expect(blob!.mime).toMatch(/^image\/(png|jpeg)$/);
  });

  it("won't double-complete a run, and drops matches already reconciled", async () => {
    const run = await draftRun();
    const first = await completeReconciliationRun(TEST_ACCOUNT_ID, run.id);
    expect(first.error).toBeNull();
    const second = await completeReconciliationRun(TEST_ACCOUNT_ID, run.id);
    expect(second.error).toMatch(/already finished/);

    // A fresh run matching the now-reconciled expense finds no candidate:
    // the matcher excludes it, so completing it touches nothing.
    const run2 = await draftRun();
    const matches = (await readReconciliationRun(TEST_ACCOUNT_ID, run2.id))!
      .data.matches;
    expect(matches[0]!.status).not.toBe("matched");
  });

  it("rejects completing a run that isn't the account's", async () => {
    const run = await draftRun(CSV, OTHER_ACCOUNT_ID);
    expect(
      await readReconciliationRun(TEST_ACCOUNT_ID, run.id),
    ).toBeUndefined();
    expect(
      await updateReconciliationDecision(TEST_ACCOUNT_ID, run.id, 0, null),
    ).toBe(false);
    const res = await completeReconciliationRun(TEST_ACCOUNT_ID, run.id);
    expect(res.error).toMatch(/not found/);
  });

  it("finds the same file again by hash (idempotency guard)", async () => {
    const run = await draftRun();
    const found = await findReconciliationRunByHash(
      TEST_ACCOUNT_ID,
      run.fileHash,
    );
    expect(found!.id).toBe(run.id);
  });

  it("discards a draft without touching expenses", async () => {
    const before = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID, reconciledAt: { not: null } },
    });
    const run = await draftRun();
    expect(await discardReconciliationRun(TEST_ACCOUNT_ID, run.id)).toBe(true);
    const done = await readReconciliationRun(TEST_ACCOUNT_ID, run.id);
    expect(done!.status).toBe("discarded");
    // Discarding changed nothing about the expenses.
    const after = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID, reconciledAt: { not: null } },
    });
    expect(after).toBe(before);
  });

  it("lists runs (drafts included) and garbage-collects stale drafts", async () => {
    const a = await draftRun();
    const b = await draftRun();
    const draft = await draftRun(); // stays in progress
    await completeReconciliationRun(TEST_ACCOUNT_ID, a.id);
    await discardReconciliationRun(TEST_ACCOUNT_ID, b.id);
    // A stale draft from 40 days ago gets collected on the next list.
    await testPrisma.reconciliationRun.create({
      data: {
        id: ulid(),
        accountId: TEST_ACCOUNT_ID,
        fileName: "stale.csv",
        fileHash: "stale",
        status: "draft",
        rowCount: 0,
        matchedCount: 0,
        createdCount: 0,
        skipped: [],
        data: { rows: [], matches: [], decisions: {} },
        createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      },
    });
    const runs = await listReconciliationRuns(TEST_ACCOUNT_ID);
    const ids = runs.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(draft.id); // in-progress drafts are listed
    expect(ids.some((id) => id === "stale")).toBe(false);
    expect(runs.find((r) => r.id === draft.id)!.status).toBe("draft");
  });

  it("detects QuickBooks .qbo files as OFX and parses them", async () => {
    // QBO is the QuickBooks WebConnect format: an OFX file with a .qbo
    // extension, in the XML 2.x form Amex and newer banks export
    // (<?xml…?><?OFX OFXHEADER="200"…?><OFX>…). Detection is
    // content-based, so the extension isn't even required.
    const qbo = [
      '<?xml version="1.0" standalone="no"?>',
      '<?OFX OFXHEADER="200" VERSION="202" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>',
      "<OFX>",
      "<SIGNONMSGSRSV1>",
      "<SONRS>",
      "<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>",
      "<DTSERVER>20260807000000.000[-7:MST]</DTSERVER>",
      "<FI><ORG>AMEX</ORG><FID>3106</FID></FI>",
      "</SONRS>",
      "</SIGNONMSGSRSV1>",
      "<CREDITCARDMSGSRSV1>",
      "<CCSTMTTRNRS>",
      "<CCSTMTRS>",
      "<BANKTRANLIST>",
      "<STMTTRN>",
      "<TRNTYPE>DEBIT</TRNTYPE>",
      "<DTPOSTED>20260705000000.000[-7:MST]</DTPOSTED>",
      "<TRNAMT>-42.50</TRNAMT>",
      "<FITID>20260705001</FITID>",
      "<NAME>BLUE BOTTLE COFFEE</NAME>",
      "</STMTTRN>",
      "</BANKTRANLIST>",
      "</CCSTMTRS>",
      "</CCSTMTTRNRS>",
      "</CREDITCARDMSGSRSV1>",
      "</OFX>",
    ].join("");
    expect(sniffStatementText(qbo)).toBe("ofx");
    const parsed = await parseStatementUpload(
      "statement.qbo",
      Buffer.from(qbo),
    );
    expect(parsed.format).toBe("ofx");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      date: "2026-07-05",
      description: "BLUE BOTTLE COFFEE",
      amount: "42.50",
      direction: "charge",
      fitId: "20260705001",
    });
  });

  it("parses an .xlsx statement with a header, numeric amounts, and a Reference column", async () => {
    const xlsx = makeXlsx([
      ["Date", "Description", "Amount", "Reference"],
      ["07/05/2026", "BLUE BOTTLE COFFEE", "42.50", "REF12345"],
      ["07/01/2026", "ONLINE PAYMENT - THANK YOU", "-1260.08", "REF54321"],
    ]);
    const parsed = await parseStatementUpload("statement.xlsx", xlsx);
    expect(parsed.format).toBe("xlsx");
    expect(parsed.skipped).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      date: "2026-07-05",
      description: "BLUE BOTTLE COFFEE",
      amount: "42.50",
      direction: "charge",
      fitId: "REF12345",
    });
    expect(parsed.rows[1]).toMatchObject({
      direction: "refund",
      fitId: "REF54321",
    });
  });

  it("skips title rows above the .xlsx header (bank export layout)", async () => {
    const xlsx = makeXlsx([
      ["Transaction Details"],
      ["Prepared for"],
      ["ASSAF ARKIN"],
      ["Date", "Description", "Card Member", "Account #", "Amount", "Category"],
      [
        "07/12/2026",
        "RENEWAL MEMBERSHIP FEE",
        "ASSAF ARKIN",
        "-12004",
        "95",
        "Fees & Adjustments",
      ],
      [
        "07/10/2026",
        "AplPay H MART LA2 CALOS ANGELES",
        "ASSAF ARKIN",
        "-12004",
        "126.5",
        "Groceries",
      ],
    ]);
    const parsed = await parseStatementUpload("statement.xlsx", xlsx);
    expect(parsed.format).toBe("xlsx");
    expect(parsed.rows).toHaveLength(2);
    // The "Fees & Adjustments" category must not read as a refund.
    expect(parsed.rows[0]).toMatchObject({
      amount: "95.00",
      direction: "charge",
    });
    expect(parsed.rows[1]).toMatchObject({
      amount: "126.50",
      direction: "charge",
    });
  });

  it("infers the charge sign from the file's majority (Amex: positives are charges)", async () => {
    const xlsx = makeXlsx([
      ["Date", "Description", "Amount"],
      ["07/05/2026", "BLUE BOTTLE COFFEE", "42.50"],
      ["07/06/2026", "H MART", "126.50"],
      ["07/07/2026", "SOME PLAIN CREDIT", "-50.00"],
    ]);
    const parsed = await parseStatementUpload("statement.xlsx", xlsx);
    // Majority positive → positive is the charge sign; the plain negative
    // credit (no keyword) classifies as a refund.
    expect(parsed.rows.map((r) => r.direction)).toEqual([
      "charge",
      "charge",
      "refund",
    ]);
  });

  it("still handles Chase-style negative charges in xlsx (negatives are the majority)", async () => {
    const xlsx = makeXlsx([
      ["Date", "Description", "Amount"],
      ["2026-07-05", "TEST STORE PURCHASE", "-42.50"],
      ["2026-07-06", "OFFICEMAX", "-15.99"],
      ["2026-07-07", "PLAIN CREDIT", "9.99"],
    ]);
    const parsed = await parseStatementUpload("statement.xlsx", xlsx);
    expect(parsed.rows.map((r) => r.direction)).toEqual([
      "charge",
      "charge",
      "refund",
    ]);
  });

  it("parses a real QFX file end to end through the store", async () => {
    // DevShop (99.99 @ 2026-04-05) and Misc (12.00 @ 2026-05-01): expenses
    // the earlier completion tests haven't touched.
    const qfx = [
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "VERSION:102",
      "",
      "<OFX>",
      "<CREDITCARDMSGSRSV1>",
      "<CCSTMTTRNRS>",
      "<CCSTMTRS>",
      "<CURDEF>USD</CURDEF>",
      "<BANKTRANLIST>",
      "<STMTTRN>",
      "<DTPOSTED>20260405</DTPOSTED>",
      "<TRNAMT>-99.99</TRNAMT>",
      "<FITID>f1</FITID>",
      "<NAME>DEVSHOP PURCHASE</NAME>",
      "</STMTTRN>",
      "<STMTTRN>",
      "<DTPOSTED>20260501</DTPOSTED>",
      "<TRNAMT>-12.00</TRNAMT>",
      "<FITID>f2</FITID>",
      "<NAME>MISC EXPENSE</NAME>",
      "</STMTTRN>",
      "</BANKTRANLIST>",
      "</CCSTMTRS>",
      "</CCSTMTTRNRS>",
      "</CREDITCARDMSGSRSV1>",
      "</OFX>",
    ].join("\n");
    const parsed = parseStatementText(qfx, "ofx");
    const expenses = await readExpenses(TEST_ACCOUNT_ID);
    const matches = matchStatementRows(parsed.rows, expenses);
    expect(parsed.rows).toHaveLength(2);
    expect(matches[0]!.status).toBe("matched");
    expect(matches[1]!.status).toBe("matched");
    const run = await createReconciliationRun(TEST_ACCOUNT_ID, {
      id: ulid(),
      fileName: "chase.qfx",
      fileHash: `hash-${ulid()}`,
      rows: parsed.rows,
      matches,
      skipped: parsed.skipped,
    });
    const res = await completeReconciliationRun(TEST_ACCOUNT_ID, run.id);
    expect(res.error).toBeNull();
    expect(res.result!.matched).toBe(2);
  });
});
