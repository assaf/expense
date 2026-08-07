import Decimal from "decimal.js";
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
 * date + exact amount + shared merchant token → high-confidence match.
 * Anything close but not exact, any ambiguity (several candidates, or two
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
 * (08/03/2026, 8/3/26), or a month name (Aug 3 2026, Aug 3, 2026, 3 Aug 2026). */
export function normalizeDate(value: string): string | null {
  const s = value.trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    const year = us[3]!.length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  }
  const namedMonthFirst = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (namedMonthFirst) {
    const month = MONTHS[namedMonthFirst[1]!.slice(0, 3).toLowerCase()];
    if (month) {
      return `${namedMonthFirst[3]}-${month}-${namedMonthFirst[2]!.padStart(2, "0")}`;
    }
  }
  const namedDayFirst = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/);
  if (namedDayFirst) {
    const month = MONTHS[namedDayFirst[2]!.slice(0, 3).toLowerCase()];
    if (month) {
      return `${namedDayFirst[3]}-${month}-${namedDayFirst[1]!.padStart(2, "0")}`;
    }
  }
  return null;
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
 * word token (or are the same normalized string). */
function merchantOverlap(desc: Set<string>, merchant: Set<string>): boolean {
  if (merchant.size === 0) return false;
  return [...desc].some((t) => merchant.has(t));
}

/** Refund-ish keywords: a statement line containing any of these is a
 * credit/payment/return — a non-expense — never an auto match. */
const REFUND_RE = /refund|payment|credit|return|reversal/i;

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
  const raw = parseCsv(text);
  const rows: StatementRow[] = [];
  const skipped: SkippedLine[] = [];
  if (raw.length === 0) return { rows, skipped };

  // Column mapping: use a header row when one is recognizable.
  const header = raw[0]!.map((h) => h.trim().toLowerCase());
  const dateIdx = header.findIndex((h) => /date/.test(h));
  const descIdx = header.findIndex((h) => /desc|merchant|payee|name/.test(h));
  const amtIdx = header.findIndex((h) => /amount/.test(h));
  const debitIdx = header.findIndex((h) => /debit/.test(h));
  const creditIdx = header.findIndex((h) => /credit/.test(h));
  const typeIdx = header.findIndex(
    (h) => /^type$/.test(h) || /category/.test(h),
  );
  const hasHeader =
    dateIdx >= 0 || amtIdx >= 0 || debitIdx >= 0 || creditIdx >= 0;
  const body = hasHeader ? raw.slice(1) : raw;

  // Does the amount column carry signs anywhere in the file?
  let hasNegative = false;
  for (const cells of body) {
    const v =
      debitIdx >= 0
        ? (cells[debitIdx] ?? "")
        : (cells[amtIdx >= 0 ? amtIdx : 2] ?? "");
    if (parseMoney(v)?.isNegative()) {
      hasNegative = true;
      break;
    }
  }

  const startLine = hasHeader ? 2 : 1; // 1-based line of the first body row
  for (const [i, cells] of body.entries()) {
    const line = startLine + i;
    const rawRow = cells.join(",");
    const date = normalizeDate(
      hasHeader ? (cells[dateIdx] ?? "") : (cells[0] ?? ""),
    );
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
        direction = directionFor(
          signed,
          `${typeText} ${description}`,
          hasNegative,
        );
      }
    }
    if (!amount || amount.isZero()) {
      skipped.push({ line, raw: rawRow, reason: "No recognizable amount." });
      continue;
    }
    rows.push({
      index: rows.length,
      date,
      description,
      amount: amount.toFixed(2),
      direction,
      source: "csv",
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
    const posted = ofxField(b, "DTPOSTED");
    const date = normalizeOfxDate(posted);
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

/** Match a trailing amount (with optional $, sign, or parens). */
const PDF_AMOUNT_END =
  /(-?\$?\d{1,3}(?:,\d{3})*\.\d{2}|\(\$?\d{1,3}(?:,\d{3})*\.\d{2}\))\s*$/;
/** A line that is nothing but a date. */
const PDF_DATE_ONLY =
  /^(?:[A-Za-z]{3,}\.?\s+\d{1,2},?(?:\s+\d{4})?|\d{1,2}\s+[A-Za-z]{3,}\.?(?:\s+\d{4})?|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})$/;
/** A line that is nothing but an amount. */
const PDF_AMOUNT_ONLY =
  /^-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?$|^\(\$?\d{1,3}(?:,\d{3})*\.\d{2}\)$/;

/** Try "<date> <description> <amount>" on one line; the date is a prefix
 * (up to 3 tokens), the amount is the trailing token. */
function tryPdfOneLine(line: string): {
  date: string;
  description: string;
  signed: Decimal;
} | null {
  const amountM = line.match(PDF_AMOUNT_END);
  if (!amountM) return null;
  const before = line.slice(0, amountM.index).trim();
  const parts = before.split(/\s+/);
  for (let k = 1; k <= Math.min(3, parts.length); k++) {
    const date = normalizeDate(parts.slice(0, k).join(" "));
    if (!date) continue;
    const description = parts.slice(k).join(" ").trim();
    const signed = parseMoney(amountM[1]!);
    if (!description || !signed || signed.isZero()) return null;
    return { date, description, signed };
  }
  return null;
}

/** Parse statement text extracted from a PDF (see extractPdfLines) into
 * rows. Handles one-line "<date> <desc> <amount>" rows and the common
 * multi-line layout (a date line, then description lines, then an amount
 * line). Everything else is reported as skipped — the UI shows those lines
 * so the user can judge what the parser missed. */
export function parsePdfStatementLines(lines: string[]): {
  rows: StatementRow[];
  skipped: SkippedLine[];
} {
  const rows: StatementRow[] = [];
  const skipped: SkippedLine[] = [];
  let pending: {
    date: string;
    desc: string[];
    line: number;
  } | null = null;

  let hasNegative = false;
  for (const line of lines) {
    const one = tryPdfOneLine(line);
    if (one && one.signed.isNegative()) {
      hasNegative = true;
      break;
    }
    const amtOnly = line.trim().match(PDF_AMOUNT_ONLY);
    if (amtOnly && parseMoney(amtOnly[0])?.isNegative()) {
      hasNegative = true;
      break;
    }
  }

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
    const line = rawLine.trim();
    if (!line) continue;

    const one = tryPdfOneLine(line);
    if (one) {
      closePending("No amount found before the next row.");
      rows.push({
        index: rows.length,
        date: one.date,
        description: one.description.slice(0, 120),
        amount: one.signed.abs().toFixed(2),
        direction: directionFor(one.signed, one.description, hasNegative),
        source: "pdf",
        raw: line.slice(0, 160),
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
          direction: directionFor(signed, desc, hasNegative),
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
      const date = normalizeDate(line);
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
export function sniffStatementText(text: string): "csv" | "ofx" {
  const head = text.slice(0, 500).trim();
  return head.startsWith("OFXHEADER") || head.startsWith("<OFX")
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

/** Parse an uploaded statement file (CSV / QFX / OFX / PDF), detecting the
 * format from the extension and the bytes. */
export async function parseStatementUpload(
  fileName: string,
  buffer: Buffer,
): Promise<{
  rows: StatementRow[];
  skipped: SkippedLine[];
  format: "csv" | "ofx" | "pdf";
}> {
  const head = buffer.subarray(0, 8).toString("latin1");
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (head.startsWith("%PDF") || ext === "pdf") {
    const lines = await extractPdfLines(buffer);
    return { ...parsePdfStatementLines(lines), format: "pdf" };
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
  const pool: { e: ReceiptExpense; abs: Decimal; tokens: Set<string> }[] = [];
  for (const e of expenses) {
    if (e.type !== "receipt") continue;
    if (!e.date || e.reconciledAt) continue;
    const abs = parseAmount(e.amount)?.abs();
    if (!abs || abs.isZero()) continue;
    pool.push({ e, abs, tokens: tokensOf(e.merchant) });
  }

  const stmtAbs = rows.map((r) => parseAmount(r.amount));
  const descTokens = rows.map((r) => tokensOf(r.description));

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
    const desc = descTokens[i]!;
    let best = list[0]!;
    let bestScore = -1;
    for (const p of list) {
      const overlap = [...p.tokens].filter((t) => desc.has(t)).length;
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

  rows.forEach((row, i) => {
    const match = matches[i]!;
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
  });

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
