import Decimal from "decimal.js";
import { parseXlsxSheets } from "~/lib/excel.server";
import { extractPdfLines } from "~/lib/receipt-ocr.server";
import { parseAmount } from "~/lib/money";
import type {
  Expense,
  MatchCandidate,
  ReceiptExpense,
  RowMatch,
  SkippedLine,
  StatementRow,
} from "~/lib/types";

/**
 * Statement parsing + reconciliation matching, shared by the web reconcile
 * flow (/reconcile) and the MCP `reconcile` tool.
 *
 * Formats: CSV (header detection, US/ISO/named dates, signed amounts or
 * Debit/Credit split), QFX/OFX (SGML blocks, FITID transaction ids), and
 * PDF (text layer reconstructed into lines — scanned PDFs have no text and
 * are reported as unparseable; banks all offer CSV/QFX anyway).
 *
 * Every parsed row normalizes to the same shape: an absolute amount plus a
 * direction (charge | refund), so a Chase-style signed CSV, a Citi-style
 * Debit/Credit split, and an OFX file all match identically. Refund rows
 * never auto-match an expense — a refund is not a deductible expense — and
 * land in the unmatched bucket for the user to discard.
 *
 * Matching rules (see matchStatementRows): receipt expenses only (mileage
 * is never a card transaction), not already reconciled, same direction,
 * date within ±2 days and amount within $0.50 / 1% of the expense. Exact
 * date + exact amount + shared merchant token — or shared after joining
 * adjacent words, so "OFFICE MAX" matches merchant "OfficeMax" — →
 * high-confidence match. Anything close but not exact, any ambiguity (several candidates, or two
 * statement lines claiming the same expense), or a merchant that differs →
 * review, where the user picks.
 */

/** Statement dates and expense dates may differ by up to this many days and
 * still be candidates — statements carry the posting date, users enter the
 * purchase date, and they drift by a day or two. */
export const DATE_TOLERANCE_DAYS = 2;

/** Amount tolerance: within $0.50 or 1% of the expense amount, whichever is
 * larger. Catches posting/purchase rounding without letting a $25 charge
 * match a $28 expense (tips stay unmatched). */
export function withinAmount(stmtAbs: Decimal, expenseAbs: Decimal): boolean {
  const tolerance = expenseAbs.mul("0.01").gte("0.50")
    ? expenseAbs.mul("0.01")
    : new Decimal("0.50");
  return stmtAbs.minus(expenseAbs).abs().lte(tolerance);
}

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** Normalize a statement date to YYYY-MM-DD: ISO (2026-08-03), US
 * (08/03/2026, 8/3/26), or a month name (Aug 3 2026, Aug 3, 2026, 3 Aug 2026).
 * Rejects impossible dates (month 26, Feb 30). */
export function normalizeDate(value: string): string | null {
  const s = value.trim();
  if (!s) return null;
  const make = (y: number, m: number, d: number): string | null => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (
      dt.getUTCFullYear() !== y ||
      dt.getUTCMonth() !== m - 1 ||
      dt.getUTCDate() !== d
    ) {
      return null;
    }
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return make(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    const year = us[3]!.length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    return make(year, Number(us[1]), Number(us[2]));
  }
  const namedMonthFirst = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (namedMonthFirst) {
    const month = MONTHS[namedMonthFirst[1]!.slice(0, 3).toLowerCase()];
    if (month) {
      return make(
        Number(namedMonthFirst[3]),
        Number(month),
        Number(namedMonthFirst[2]),
      );
    }
  }
  const namedDayFirst = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/);
  if (namedDayFirst) {
    const month = MONTHS[namedDayFirst[2]!.slice(0, 3).toLowerCase()];
    if (month) {
      return make(
        Number(namedDayFirst[3]),
        Number(month),
        Number(namedDayFirst[1]),
      );
    }
  }
  return null;
}

/** Earliest of the given dates (YYYY-MM-DD strings sort lexicographically),
 * or null when none parse. Statements carry both a transaction date and a
 * posting date — the transaction date is the purchase event, posting is a
 * settlement artifact a day or two later, so the earliest always wins. */
function earliestDate(dates: (string | null)[]): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (d && (!best || d < best)) best = d;
  }
  return best;
}

/** Parse a statement amount: $ and commas stripped, (12.34) and -12.34 are
 * negative, plain "12.34" positive. Never returns an IEEE float. */
export function parseMoney(value: string): Decimal | null {
  const s = value.trim();
  if (!s) return null;
  let neg = false;
  let body = s;
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    body = s.slice(1, -1);
  }
  const m = body.replace(/[$,\s]/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const d = new Decimal(m[0]);
  return neg ? d.neg() : d;
}

/** Word tokens (≥3 chars, lowercased) for merchant/description overlap. */
export function tokensOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

/** Calendar-day difference between two YYYY-MM-DD dates. */
function dayDiff(a: string, b: string): number {
  const da = Date.UTC(
    Number(a.slice(0, 4)),
    Number(a.slice(5, 7)) - 1,
    Number(a.slice(8, 10)),
  );
  const db = Date.UTC(
    Number(b.slice(0, 4)),
    Number(b.slice(5, 7)) - 1,
    Number(b.slice(8, 10)),
  );
  return Math.abs(Math.round((da - db) / 86_400_000));
}

/** True when the statement description and the expense merchant share a
 * word token, or share one after concatenating adjacent words — the
 * "OfficeMax" ↔ "OFFICE MAX" case: the two name the same merchant once
 * spaces are removed but share no single token. Exact string equality
 * only — no fuzzy thresholds, so genuinely different merchants never
 * collide ("Star" stays apart from "Starbucks"). */
function merchantOverlap(desc: Set<string>, merchant: Set<string>): boolean {
  if (merchant.size === 0) return false;
  const d = expandedTokens(desc);
  const m = expandedTokens(merchant);
  return [...m].some((t) => d.has(t));
}

/** Expand a token set with the concatenation of adjacent tokens (windows
 * of 2–3, in text order) — "OFFICE MAX" → {office, max, officemax}.
 * Word-boundary differences ("Office Max" / "OfficeMax" / "OFFICE-MAX")
 * collapse to the same string; genuinely different names never do. */
function expandedTokens(tokens: Set<string>): Set<string> {
  const list = [...tokens];
  const out = new Set(list);
  for (let i = 0; i < list.length; i++) {
    for (let w = 2; w <= 3 && i + w <= list.length; w++) {
      out.add(list.slice(i, i + w).join(""));
    }
  }
  return out;
}

/** Refund-ish keywords: a statement line containing any of these is a
 * credit/payment/return — a non-expense — never an auto match. Covers the
 * common abbreviations and labels across banks ("ONLINE PYMT", "CASH
 * BACK", "PURCHASE ADJUSTMENT", "CASH REBATE", "ACH Deposit"). */
const REFUND_RE =
  /refund|payment|pymt|credit|cash\s?back|adjustment|rebate|deposit|return|reversal/i;

/** Direction for a signed amount: credit-card convention (negative = the
 * purchase, positive = a credit), guarded by whether the file carries signs
 * at all — unsigned files are all charges. */
function directionFor(
  signed: Decimal,
  description: string,
  fileHasNegative: boolean,
): "charge" | "refund" {
  if (REFUND_RE.test(description)) return "refund";
  if (!fileHasNegative) return "charge";
  return signed.isNegative() ? "charge" : "refund";
}

/** Direction for CSV/XLSX amounts, where the charge sign varies by bank
 * (Chase CSVs list purchases as negatives; Amex exports list them as
 * positives). `chargeIsPositive` comes from the file's majority sign;
 * refund keywords still win first. */
function directionForSign(
  signed: Decimal,
  description: string,
  chargeIsPositive: boolean,
): "charge" | "refund" {
  if (REFUND_RE.test(description)) return "refund";
  const negativeIsCharge = !chargeIsPositive;
  return signed.isNegative() === negativeIsCharge ? "charge" : "refund";
}

/** Strong, unambiguous direction words for a Type/Category column. The
 * full REFUND_RE is too eager here — "Fees & Adjustments" is a category,
 * not a refund. */
const TYPE_REFUND_RE = /payment|refund|credit|return|reversal|cash\s?back/i;

// --- CSV -------------------------------------------------------------------

/** Parse CSV text (RFC 4180-ish: quotes, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** Parse a statement CSV into normalized rows. Handles a recognizable
 * header (date / description / amount / debit / credit / type columns) or
 * the plain date,description,amount shape, and both signed single-column
 * amounts (Chase) and Debit/Credit splits (Citi). */
export function parseStatementCsv(text: string): {
  rows: StatementRow[];
  skipped: SkippedLine[];
} {
  return parseStatementCells(parseCsv(text), "csv");
}

/**
 * Turn a grid of cells (CSV rows or an .xlsx sheet) into statement rows.
 * Shared by the CSV and Excel parsers: header detection, column mapping,
 * date/amount normalization, and refund classification are identical
 * either way. `lineOffset` is the 1-based line of the first cell row in
 * its source (0 for CSV, the sheet's header row index for Excel) so the
 * skipped report points at real lines. `refIdx` (an Excel "Reference"
 * column) is carried as the row's FITID when present.
 */
function parseStatementCells(
  raw: string[][],
  source: "csv" | "xlsx",
  lineOffset = 0,
): {
  rows: StatementRow[];
  skipped: SkippedLine[];
} {
  const rows: StatementRow[] = [];
  const skipped: SkippedLine[] = [];
  if (raw.length === 0) return { rows, skipped };

  // Column mapping: use a header row when one is recognizable.
  const header = raw[0]!.map((h) => h.trim().toLowerCase());
  // Every date column ("Transaction Date", "Posting Date", …), not just the
  // first: the row's date is the EARLIEST of them — the transaction date.
  // Posting is a settlement artifact a day or two later, and column order
  // varies by bank, so the first date column is not trustworthy.
  const dateIdxs = header.flatMap((h, i) => (/date/.test(h) ? [i] : []));
  const descIdx = header.findIndex((h) => /desc|merchant|payee|name/.test(h));
  const amtIdx = header.findIndex((h) => /amount/.test(h));
  const debitIdx = header.findIndex((h) => /debit/.test(h));
  const creditIdx = header.findIndex((h) => /credit/.test(h));
  const typeIdx = header.findIndex(
    (h) => /^type$/.test(h) || /category/.test(h),
  );
  const refIdx = header.findIndex((h) => /reference|ref\s*num/.test(h));
  const hasHeader =
    dateIdxs.length > 0 || amtIdx >= 0 || debitIdx >= 0 || creditIdx >= 0;
  const body = hasHeader ? raw.slice(1) : raw;

  // Which sign do charges use? Sign conventions vary by bank (Chase CSVs
  // list purchases as negatives; Amex exports list them as positives), so
  // it's inferred: rows already classified as refunds by keywords are
  // excluded, and the majority sign of the rest is the charge sign.
  let negativeCount = 0;
  let positiveCount = 0;
  for (const cells of body) {
    if (debitIdx >= 0 || creditIdx >= 0) continue; // two-column split needs no sign
    const desc = (
      hasHeader && descIdx >= 0 ? (cells[descIdx] ?? "") : (cells[1] ?? "")
    ).trim();
    const typeText = typeIdx >= 0 ? (cells[typeIdx] ?? "") : "";
    if (TYPE_REFUND_RE.test(typeText) || REFUND_RE.test(desc)) continue;
    const d = parseMoney(cells[amtIdx >= 0 ? amtIdx : 2] ?? "");
    if (d?.isNegative()) negativeCount++;
    else if (d?.gt(0)) positiveCount++;
  }
  const chargeIsPositive = positiveCount > negativeCount;

  const startLine = (hasHeader ? 2 : 1) + lineOffset; // 1-based first body row
  for (const [i, cells] of body.entries()) {
    const line = startLine + i;
    const rawRow = cells.join(",");
    const date = hasHeader
      ? earliestDate(dateIdxs.map((idx) => normalizeDate(cells[idx] ?? "")))
      : normalizeDate(cells[0] ?? "");
    if (date === null) {
      skipped.push({ line, raw: rawRow, reason: "No recognizable date." });
      continue;
    }
    const description = (
      hasHeader && descIdx >= 0 ? (cells[descIdx] ?? "") : (cells[1] ?? "")
    ).trim();

    let amount: Decimal | null = null;
    let direction: "charge" | "refund" = "charge";
    if (debitIdx >= 0 || creditIdx >= 0) {
      const debit = parseMoney(cells[debitIdx] ?? "");
      const credit = parseMoney(cells[creditIdx] ?? "");
      if (debit && !debit.isZero()) {
        amount = debit.abs();
        direction = "charge";
      } else if (credit && !credit.isZero()) {
        amount = credit.abs();
        direction = "refund";
      }
    } else {
      const signed = parseMoney(cells[amtIdx >= 0 ? amtIdx : 2] ?? "");
      if (signed) {
        amount = signed.abs();
        const typeText = typeIdx >= 0 ? (cells[typeIdx] ?? "") : "";
        // The type/category column is only trusted for unambiguous
        // direction words — category names like "Fees & Adjustments"
        // contain refund-ish words without being refunds.
        if (TYPE_REFUND_RE.test(typeText)) {
          direction = "refund";
        } else {
          direction = directionForSign(signed, description, chargeIsPositive);
        }
      }
    }
    if (!amount || amount.isZero()) {
      skipped.push({ line, raw: rawRow, reason: "No recognizable amount." });
      continue;
    }
    const fitId =
      refIdx >= 0 && (cells[refIdx] ?? "").trim()
        ? cells[refIdx]!.trim()
        : undefined;
    rows.push({
      index: rows.length,
      date,
      description,
      amount: amount.toFixed(2),
      direction,
      ...(fitId ? { fitId } : {}),
      source,
      raw: rawRow,
    });
  }
  return { rows, skipped };
}

// --- QFX / OFX -------------------------------------------------------------

/** Value of a single <TAG>…</TAG> field inside an OFX block. */
function ofxField(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1]!.trim() : "";
}

/** OFX date 20260803120000.000[-8:PST] → 2026-08-03. */
function normalizeOfxDate(value: string): string | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Parse an OFX/QFX statement (SGML <STMTTRN> blocks; the OFXHEADER block
 * before <OFX> is skipped). FITID — the bank's unique transaction id — is
 * carried on each row as the idempotency key. */
export function parseOfxStatement(text: string): {
  rows: StatementRow[];
  skipped: SkippedLine[];
} {
  const rows: StatementRow[] = [];
  const skipped: SkippedLine[] = [];
  const ofxStart = text.indexOf("<OFX>");
  const body = ofxStart >= 0 ? text.slice(ofxStart) : text;
  const blocks: string[] = [];
  const blockRe = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body))) blocks.push(m[1]!);
  if (blocks.length === 0) {
    skipped.push({
      line: 1,
      raw: "No <STMTTRN> blocks found",
      reason: "Not an OFX/QFX statement.",
    });
    return { rows, skipped };
  }

  let hasNegative = false;
  for (const b of blocks) {
    if (parseMoney(ofxField(b, "TRNAMT"))?.isNegative()) {
      hasNegative = true;
      break;
    }
  }

  for (const [i, b] of blocks.entries()) {
    // The earliest of the block's dates: DTPOSTED is the posting date and
    // DTUSER — the user's transaction date — is a day or two earlier when
    // present (Chase QFX carries both). DTAVAIL is rarely populated.
    const posted = ofxField(b, "DTPOSTED");
    const date = earliestDate(
      ["DTPOSTED", "DTUSER", "DTAVAIL"].map((tag) =>
        normalizeOfxDate(ofxField(b, tag)),
      ),
    );
    const signed = parseMoney(ofxField(b, "TRNAMT"));
    const description = (
      ofxField(b, "NAME") ||
      ofxField(b, "MEMO") ||
      ""
    ).trim();
    const fitId = ofxField(b, "FITID") || undefined;
    if (!date || !signed || signed.isZero()) {
      skipped.push({
        line: i + 1,
        raw: `STMTTRN #${i + 1}${description ? `: ${description}` : ""}`,
        reason: "Missing date or amount.",
      });
      continue;
    }
    rows.push({
      index: rows.length,
      date,
      description,
      amount: signed.abs().toFixed(2),
      direction: directionFor(signed, description, hasNegative),
      fitId,
      source: "ofx",
      raw: `<STMTTRN> ${posted} ${signed.toFixed(2)} ${description}`.trim(),
    });
  }
  return { rows, skipped };
}

// --- PDF -------------------------------------------------------------------

/** A single amount token: optional $, sign, or parens, two decimals. */
const PDF_AMOUNT_TOKEN = /^[-($]?\$?\d[\d,]*(?:\.\d{2})\)?$/;
/** A line that is nothing but a date. */
const PDF_DATE_ONLY =
  /^(?:[A-Za-z]{3,}\.?\s+\d{1,2},?(?:\s+\d{4})?|\d{1,2}\s+[A-Za-z]{3,}\.?(?:\s+\d{4})?|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})$/;
/** A line that is nothing but an amount. */
const PDF_AMOUNT_ONLY =
  /^-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?$|^\(\$?\d{1,3}(?:,\d{3})*\.\d{2}\)$/;
/** Collapse the sign/space split banks use in amounts ("- $25.00",
 * "+ $10.00") into one token ("-$25.00"). */
const PDF_AMOUNT_SPACED = /[-+]\s*\$?\s*\d[\d,]*\.\d{2}/g;
/** Summary-page column-merge noise that happens to carry a date and an
 * amount but is not a transaction ("on the statement closing date when
 * Payments -$2,739.84 Aug 06, 2026"). */
const PDF_SUMMARY_NOISE =
  /statement|closing date|available credit|credit limit|previous balance|new balance|minimum payment|payment due|balance as of/i;

/** The statement's billing cycle — used to date yearless transaction dates
 * (Capital One prints "Jun 13" and lets the cycle header carry the year). */
interface Cycle {
  start: string; // YYYY-MM-DD
  end: string;
}

/** Cycle-window check with a few days of slack — posting dates can fall a
 * day or two outside the stated cycle (a transaction on Jun 11 posts Jun
 * 12, the cycle's first day). */
function inCycle(date: string, cycle: Cycle): boolean {
  const SLACK_MS = 3 * 86_400_000;
  const d = Date.parse(`${date}T00:00:00Z`);
  return (
    d >= Date.parse(`${cycle.start}T00:00:00Z`) - SLACK_MS &&
    d <= Date.parse(`${cycle.end}T00:00:00Z`) + SLACK_MS
  );
}

/** Find "Jun 12, 2026 - Jul 12, 2026" or "06/08/26 - 07/07/26" cycle
 * headers (named and numeric — Capital One and Chase print them
 * differently). */
function extractCycle(lines: string[]): Cycle | null {
  const patterns = [
    // "Jun 12, 2026 - Jul 12, 2026" (Capital One)
    /([A-Za-z]{3,}\.?\s+\d{1,2},?\s+\d{4})\s*[-–—]\s*([A-Za-z]{3,}\.?\s+\d{1,2},?\s+\d{4})/,
    // "06/08/26 - 07/07/26" (Chase)
    /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–—]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/,
    // "Jul 1 — Jul 31, 2026" (Apple Card — the first date carries no year)
    /([A-Za-z]{3,}\.?\s+\d{1,2})\s*[-–—]\s*([A-Za-z]{3,}\.?\s+\d{1,2},?\s+\d{4})/,
  ];
  for (const line of lines) {
    for (const re of patterns) {
      const m = line.match(re);
      if (!m) continue;
      const end = normalizeDate(m[2]!);
      if (!end) continue;
      const start =
        normalizeDate(m[1]!) ??
        resolveYearlessDate(m[1]!, { start: "0001-01-01", end });
      if (start && start <= end) return { start, end };
    }
  }
  return null;
}

/** Resolve a yearless date against the billing cycle — a statement only
 * lists transactions inside its cycle, so the year is unambiguous (and a
 * date far outside the cycle is a description, not a transaction). Handles
 * month names ("Jun 13", Capital One) and numeric dates ("07/01", Chase). */
function resolveYearlessDate(
  monthDay: string,
  cycle: Cycle | null,
): string | null {
  const m =
    monthDay.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})$/) ??
    monthDay.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const month = m[1]!.match(/^\d/)
    ? m[1]
    : MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  const day = m[2]!;
  if (!month) return null;
  const endYear = cycle
    ? Number(cycle.end.slice(0, 4))
    : new Date().getFullYear();
  const candidate = `${endYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!normalizeDate(candidate)) return null; // impossible date (month 13)
  if (cycle && !inCycle(candidate, cycle)) {
    // Year-crossing cycle (Nov 2026 – Jan 2027): try the previous year.
    const prev = `${endYear - 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (inCycle(prev, cycle)) return prev;
    return null;
  }
  return candidate;
}

/**
 * Try "<description> <date> <amount>" on one line, in any order — bank
 * PDFs put the date and amount anywhere on the line (Amex:
 * "AplPay RALPHS GROCERY STUDIO CITY CA 06/14/26 $143.21" and even
 * "…CA $112.71 06/24/26"). Requires exactly one amount token; every
 * date token (1–3 token windows, since named dates are three tokens:
 * "Aug 3 2026", and yearless "Jun 13" is two) is stripped from the
 * description — Capital One rows carry both a transaction and a posting
 * date, and the EARLIEST of them becomes the row date (the transaction
 * date; posting is a settlement artifact a day or two later). Two amount
 * tokens means a summary/table line, not a transaction.
 */
function tryPdfOneLine(
  line: string,
  cycle: Cycle | null,
): {
  date: string;
  description: string;
  signed: Decimal;
} | null {
  const tokens = line
    .trim()
    .replace(PDF_AMOUNT_SPACED, (m) => m.replace(/\s+/g, ""))
    .split(/\s+/);
  if (tokens.length < 3) return null;

  // Amount tokens. Apple Card rows carry the Daily Cash amount before the
  // transaction amount ("…USA 2% $0.18 $8.83"). Two amounts are normally
  // a summary/table line — but a percentage token right before the first
  // amount marks the daily-cash layout, where the LAST amount is the
  // transaction and both amounts + the percentage are column noise.
  const amountIndices: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (PDF_AMOUNT_TOKEN.test(tokens[i]!)) amountIndices.push(i);
    if (amountIndices.length > 2) return null;
  }
  if (amountIndices.length === 0) return null;
  if (amountIndices.length === 2) {
    const first = amountIndices[0]!;
    if (!tokens[first - 1]?.endsWith("%")) return null; // summary line
  }
  const amountIndex = amountIndices[amountIndices.length - 1]!;
  const signed = parseMoney(tokens[amountIndex]!);
  if (!signed || signed.isZero()) return null;

  const dateWindows: { start: number; len: number }[] = [];
  const dates: string[] = [];
  /** Date at token i: yearful windows first ("Aug 3 2026" must not be
   * truncated to yearless "Aug 3"), then a yearless date — "07/01" is
   * one token (Chase), "Jun 13" is two (Capital One) — resolved against
   * the billing cycle. */
  const findDate = (i: number): { date: string; len: number } | null => {
    for (let len = 1; len <= 3 && i + len <= tokens.length; len++) {
      if (i <= amountIndex && i + len > amountIndex) break; // crosses the amount
      const d = normalizeDate(tokens.slice(i, i + len).join(" "));
      if (d) return { date: d, len };
    }
    if (!(i <= amountIndex && i + 1 > amountIndex)) {
      const d = resolveYearlessDate(tokens[i]!, cycle);
      if (d) return { date: d, len: 1 };
    }
    if (i + 2 <= tokens.length && !(i <= amountIndex && i + 2 > amountIndex)) {
      const d = resolveYearlessDate(tokens.slice(i, i + 2).join(" "), cycle);
      if (d) return { date: d, len: 2 };
    }
    return null;
  };
  for (let i = 0; i < tokens.length; i++) {
    if (i === amountIndex) continue;
    if (dateWindows.some((w) => i >= w.start && i < w.start + w.len)) continue;
    const found = findDate(i);
    if (!found) continue;
    dates.push(found.date);
    dateWindows.push({ start: i, len: found.len });
    i += found.len - 1;
  }
  if (dateWindows.length === 0) return null;
  // Both dates present (Capital One prints trans + posting): take the
  // earliest — the transaction date.
  const date = earliestDate(dates)!;

  const description = tokens
    .filter((t, i) => {
      if (amountIndices.includes(i)) return false;
      // Daily-cash layout: the percentage column is noise too.
      if (amountIndices.length === 2 && t.endsWith("%")) return false;
      return !dateWindows.some((w) => i >= w.start && i < w.start + w.len);
    })
    .join(" ")
    .trim();
  // Column-merge artifacts: a dangling sign or a summary-page label.
  if (
    !description ||
    description.endsWith("-") ||
    PDF_SUMMARY_NOISE.test(description)
  ) {
    return null;
  }
  return { date, description, signed };
}

/** Direction for a PDF row. Every credit-card PDF seen in the wild lists
 * payments and credits as negative amounts and charges as positive (Amex,
 * Capital One, Chase, Apple Card all do — the Chase CSV convention of
 * negative-purchases is a CSV thing). Credits carry refund-ish keywords;
 * a negative amount with no keyword is still a credit, never an expense;
 * everything else — including fees — is a charge. */
function pdfDirection(
  description: string,
  signed: Decimal,
): "charge" | "refund" {
  if (REFUND_RE.test(description)) return "refund";
  return signed.isNegative() ? "refund" : "charge";
}

/** Parse statement text extracted from a PDF (see extractPdfLines) into
 * rows. Handles one-line rows with the date and amount anywhere on the
 * line ("<desc> <date> <amount>" in any order, with yearless dates like
 * "Jun 13" resolved against the statement's billing cycle) and the common
 * multi-line layout (a date line, then description lines, then an amount
 * line). Everything else is reported as skipped — the UI shows those
 * lines so the user can judge what the parser missed. */
export function parsePdfStatementLines(lines: string[]): {
  rows: StatementRow[];
  skipped: SkippedLine[];
} {
  const rows: StatementRow[] = [];
  const skipped: SkippedLine[] = [];
  const cycle = extractCycle(lines);
  let pending: {
    date: string;
    desc: string[];
    line: number;
  } | null = null;

  const closePending = (reason: string) => {
    if (pending) {
      skipped.push({
        line: pending.line,
        raw: pending.desc.join(" "),
        reason,
      });
      pending = null;
    }
  };

  for (const [i, rawLine] of lines.entries()) {
    const lineNo = i + 1;
    // Collapse "- $25.00" → "-$25.00" so the amount is one token; keep the
    // original text for the skipped report.
    const line = rawLine
      .trim()
      .replace(PDF_AMOUNT_SPACED, (m) => m.replace(/\s+/g, ""));
    if (!line) continue;

    const one = tryPdfOneLine(line, cycle);
    if (one) {
      closePending("No amount found before the next row.");
      rows.push({
        index: rows.length,
        date: one.date,
        description: one.description.slice(0, 120),
        amount: one.signed.abs().toFixed(2),
        direction: pdfDirection(one.description, one.signed),
        source: "pdf",
        raw: rawLine.trim().slice(0, 160),
      });
      continue;
    }

    // Amount-only line completes a pending date+description group.
    const amtOnly = line.match(PDF_AMOUNT_ONLY);
    if (amtOnly) {
      const signed = parseMoney(amtOnly[0]);
      if (pending && signed && !signed.isZero()) {
        const desc = pending.desc.join(" ");
        rows.push({
          index: rows.length,
          date: pending.date,
          description: desc.slice(0, 120),
          amount: signed.abs().toFixed(2),
          direction: pdfDirection(desc, signed),
          source: "pdf",
          raw: `${pending.date} ${desc} ${signed.toFixed(2)}`.slice(0, 160),
        });
        pending = null;
      } else if (!pending) {
        skipped.push({
          line: lineNo,
          raw: line,
          reason: "Amount with no date.",
        });
      }
      continue;
    }

    // A date-only line starts a new group.
    if (PDF_DATE_ONLY.test(line)) {
      const date = normalizeDate(line) ?? resolveYearlessDate(line, cycle);
      if (date) {
        closePending("No amount found before the next row.");
        pending = { date, desc: [], line: lineNo };
        continue;
      }
    }

    // Description continuation line.
    if (pending) {
      if (pending.desc.length < 3) pending.desc.push(line);
      continue;
    }
    // Junk (headers, footers, summary lines) — report it, don't guess.
    if (
      /statement|balance|total|page\b|payment due|credit limit|account\b|annual|interest/i.test(
        line,
      )
    ) {
      continue; // known chrome, not a transaction — stay quiet
    }
    skipped.push({
      line: lineNo,
      raw: line,
      reason: "Not a transaction line.",
    });
  }

  closePending("No amount found before the end of the statement.");
  return { rows, skipped };
}

// --- Dispatch --------------------------------------------------------------

/** Sniff whether statement text is OFX or CSV. */
/** Sniff whether statement text is OFX or CSV. Handles the SGML 1.x form
 * ("OFXHEADER:100…"), the bare form ("<OFX>…"), and the XML 2.x form
 * QuickBooks WebConnect and newer bank exports use
 * ("<?xml…?><?OFX OFXHEADER=\"200\"…?><OFX>…"). */
export function sniffStatementText(text: string): "csv" | "ofx" {
  const head = text.slice(0, 500).trim();
  return head.startsWith("OFXHEADER") ||
    head.startsWith("<OFX") ||
    head.includes("OFXHEADER=")
    ? "ofx"
    : "csv";
}

/** Parse statement text in a known format. */
export function parseStatementText(
  text: string,
  format: "csv" | "ofx",
): { rows: StatementRow[]; skipped: SkippedLine[] } {
  return format === "ofx" ? parseOfxStatement(text) : parseStatementCsv(text);
}

/** Parse an uploaded statement file (CSV / QFX / OFX / QBO / XLSX / PDF),
 * detecting the format from the extension and the bytes. */
export async function parseStatementUpload(
  fileName: string,
  buffer: Buffer,
): Promise<{
  rows: StatementRow[];
  skipped: SkippedLine[];
  format: "csv" | "ofx" | "xlsx" | "pdf";
}> {
  const head = buffer.subarray(0, 8).toString("latin1");
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (head.startsWith("%PDF") || ext === "pdf") {
    const lines = await extractPdfLines(buffer);
    return { ...parsePdfStatementLines(lines), format: "pdf" };
  }
  if (ext === "xls" || head.startsWith("\xd0\xcf\x11\xe0")) {
    // Old binary BIFF workbooks — not supported; point at the trivial fix.
    return {
      rows: [],
      skipped: [
        {
          line: 1,
          raw: fileName,
          reason:
            "This is an old .xls workbook — save it as .xlsx (File → Save As) and try again.",
        },
      ],
      format: "xlsx",
    };
  }
  if (ext === "xlsx" || head.startsWith("PK")) {
    try {
      const sheets = parseXlsxSheets(buffer);
      let lastSkipped: SkippedLine[] = [];
      for (const sheet of sheets) {
        const headerRow = sheet.findIndex((row) => {
          const h = row.map((c) => c.trim().toLowerCase());
          return (
            h.some((x) => /date/.test(x)) &&
            (h.some((x) => /amount|debit|credit/.test(x)) ||
              h.some((x) => /desc|merchant|payee|name/.test(x)))
          );
        });
        const cells = headerRow >= 0 ? sheet.slice(headerRow) : sheet;
        const parsed = parseStatementCells(
          cells,
          "xlsx",
          headerRow >= 0 ? headerRow : 0,
        );
        lastSkipped = parsed.skipped;
        if (parsed.rows.length > 0) return { ...parsed, format: "xlsx" };
      }
      return { rows: [], skipped: lastSkipped, format: "xlsx" };
    } catch (err) {
      return {
        rows: [],
        skipped: [
          {
            line: 1,
            raw: fileName,
            reason: `Not a readable .xlsx workbook: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
        format: "xlsx",
      };
    }
  }
  const text = buffer.toString("utf8");
  const format =
    ext === "ofx" || ext === "qfx" ? "ofx" : sniffStatementText(text);
  return { ...parseStatementText(text, format), format };
}

// --- Matching --------------------------------------------------------------

function toCandidate(
  p: { e: ReceiptExpense; abs: Decimal; tokens: Set<string> },
  row: StatementRow,
  stmtAbs: Decimal,
  desc: Set<string>,
): MatchCandidate {
  return {
    expenseId: p.e.id,
    merchant: p.e.merchant || "(no merchant)",
    date: p.e.date,
    amount: p.e.amount,
    exactDate: row.date === p.e.date,
    exactAmount: stmtAbs.eq(p.abs),
    merchantOverlap: merchantOverlap(desc, p.tokens),
  };
}

/**
 * Match statement rows to expenses. The candidate pool is receipt expenses
 * with a date + non-zero amount that are not already reconciled (mileage is
 * never a card transaction). See the module doc for the rules.
 */
export function matchStatementRows(
  rows: StatementRow[],
  expenses: Expense[],
): RowMatch[] {
  const pool: {
    e: ReceiptExpense;
    abs: Decimal;
    tokens: Set<string>;
    expanded: Set<string>;
  }[] = [];
  for (const e of expenses) {
    if (e.type !== "receipt") continue;
    if (!e.date || e.reconciledAt) continue;
    const abs = parseAmount(e.amount)?.abs();
    if (!abs || abs.isZero()) continue;
    const tokens = tokensOf(e.merchant);
    pool.push({ e, abs, tokens, expanded: expandedTokens(tokens) });
  }

  const stmtAbs = rows.map((r) => parseAmount(r.amount));
  const descTokens = rows.map((r) => tokensOf(r.description));
  // Expanded once per row — the scoring loop below counts shared tokens
  // and shared adjacent-token concatenations.
  const descExpanded = descTokens.map((t) => expandedTokens(t));

  // Candidate lists per row (date + amount tolerance, any sign direction).
  const candidateLists = rows.map((row, i) => {
    const abs = stmtAbs[i];
    if (!abs) return [] as typeof pool;
    const list: typeof pool = [];
    for (const p of pool) {
      if (dayDiff(row.date, p.e.date) > DATE_TOLERANCE_DAYS) continue;
      if (!withinAmount(abs, p.abs)) continue;
      list.push(p);
    }
    return list;
  });

  // Greedy best candidate per row (exact date+amount wins, then token
  // overlap, then exactness of each dimension).
  const bestByRow = candidateLists.map((list, i) => {
    if (list.length === 0) return null;
    const row = rows[i]!;
    const abs = stmtAbs[i]!;
    const exact = list.find((p) => row.date === p.e.date && abs.eq(p.abs));
    if (exact) return exact;
    const desc = descExpanded[i]!;
    let best = list[0]!;
    let bestScore = -1;
    for (const p of list) {
      const overlap = [...p.expanded].filter((t) => desc.has(t)).length;
      const score =
        overlap * 100 +
        (row.date === p.e.date ? 10 : 0) +
        (abs.eq(p.abs) ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  });

  // Collision detection: an expense that is the best candidate of two
  // statement lines is ambiguous — both lines go to review (the user picks
  // which one really is that expense; the other becomes unmatched).
  const claimedByExpense = new Map<string, number[]>();
  bestByRow.forEach((best, i) => {
    if (!best) return;
    const list = claimedByExpense.get(best.e.id) ?? [];
    list.push(i);
    claimedByExpense.set(best.e.id, list);
  });
  const conflicted = new Set<string>();
  for (const [expenseId, indices] of claimedByExpense) {
    if (indices.length > 1) conflicted.add(expenseId);
  }

  return rows.map((row, i) => {
    const list = candidateLists[i]!;
    const abs = stmtAbs[i]!;
    const desc = descTokens[i]!;
    if (row.direction === "refund" || list.length === 0) {
      return { status: "unmatched" };
    }
    const best = bestByRow[i]!;
    const exacts = list.filter((p) => row.date === p.e.date && abs.eq(p.abs));
    const conflict = conflicted.has(best.e.id);
    const candidates = list.map((p) => toCandidate(p, row, abs, desc));

    if (
      exacts.length === 1 &&
      merchantOverlap(desc, exacts[0]!.tokens) &&
      !conflict
    ) {
      const candidate = candidates.find(
        (c) => c.expenseId === exacts[0]!.e.id,
      )!;
      return {
        status: "matched",
        confidence: "high",
        expenseId: candidate.expenseId,
        candidate,
      };
    }

    // Review: merchant differs, several exact candidates, tolerance-only
    // matches, or two lines claiming the same expense.
    const reasons: string[] = [];
    if (conflict) reasons.push("Another statement line could be this expense.");
    if (exacts.length > 1) {
      reasons.push("Several expenses match this line exactly — pick one.");
    } else if (
      exacts.length === 1 &&
      !merchantOverlap(desc, exacts[0]!.tokens)
    ) {
      reasons.push("Date and amount match, but the merchant name differs.");
    } else if (exacts.length === 0) {
      reasons.push("No exact match — the date or amount differs slightly.");
    }
    return {
      status: "review",
      candidates,
      best: conflict ? null : toCandidate(best, row, abs, desc),
      reasons,
    };
  });
}

// --- MCP tool --------------------------------------------------------------

/** Reconcile for the MCP `reconcile` tool: statement text (CSV or OFX) →
 * the read-only analysis the tool has always returned, plus a `needsReview`
 * list for the new ambiguity tier. Nothing is written. */
export function reconcileForMcp(
  statementText: string,
  expenses: Expense[],
): unknown {
  const format = sniffStatementText(statementText);
  const { rows, skipped } = parseStatementText(statementText, format);
  const matches = matchStatementRows(rows, expenses);

  const matchedPairs: unknown[] = [];
  const needsReview: unknown[] = [];
  const unmatchedLines: unknown[] = [];
  const matchedExpenseIds = new Set<string>();

  // Newest first, matching the web UI — `line` still points at the
  // row's original position in the statement.
  const orderedRows = rows.toSorted(
    (a, b) => b.date.localeCompare(a.date) || a.index - b.index,
  );
  for (const row of orderedRows) {
    const match = matches[row.index]!;
    const displayAmount =
      row.direction === "refund" ? `-${row.amount}` : row.amount;
    if (match.status === "matched") {
      matchedExpenseIds.add(match.expenseId);
      matchedPairs.push({
        line: row.index + 1,
        date: row.date,
        description: row.description,
        statementAmount: displayAmount,
        expenseId: match.expenseId,
        merchant: match.candidate.merchant,
        expenseAmount: match.candidate.amount,
        confidence: match.confidence,
      });
    } else if (match.status === "review") {
      needsReview.push({
        line: row.index + 1,
        date: row.date,
        description: row.description,
        statementAmount: displayAmount,
        reasons: match.reasons,
        candidates: match.candidates.map((c) => ({
          expenseId: c.expenseId,
          merchant: c.merchant,
          expenseAmount: c.amount,
        })),
      });
      unmatchedLines.push({
        line: row.index + 1,
        date: row.date,
        description: row.description,
        amount: displayAmount,
      });
    } else {
      unmatchedLines.push({
        line: row.index + 1,
        date: row.date,
        description: row.description,
        amount: displayAmount,
      });
    }
  }

  const receipts = expenses.filter(
    (e): e is ReceiptExpense =>
      e.type === "receipt" && Boolean(e.date) && Boolean(e.amount),
  );
  const unmatchedExpenses = receipts
    .filter((e) => !matchedExpenseIds.has(e.id))
    .map((e) => ({
      id: e.id,
      date: e.date,
      merchant: e.merchant || "(no merchant)",
      amount: e.amount,
    }));

  return {
    statementLines: rows.length,
    matched: matchedPairs.length,
    matchedPairs,
    needsReview,
    unmatchedLines,
    unmatchedExpenses,
    skippedLines: skipped,
    note: "Reconciliation is read-only — it never writes or dismisses anything.",
  };
}
