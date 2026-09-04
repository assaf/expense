import { unzipSync } from "fflate";
import { load } from "cheerio";

/**
 * Minimal .xlsx (OOXML spreadsheet) reader, enough for bank statement
 * exports. An .xlsx is a ZIP of XML: workbook.xml lists the sheets,
 * workbook.xml.rels maps each sheet's r:id to its worksheet file,
 * sharedStrings.xml holds the shared text, and each worksheet has the
 * grid of cells. Cells are resolved to plain strings (shared strings,
 * numbers, inline strings), placed by their column reference so sparse
 * rows come out right, with trailing empties trimmed.
 *
 * Excel date cells (serial numbers with a date number-format) are
 * converted to ISO YYYY-MM-DD. "Date-ness" lives in the cell's style:
 * cell → `s` attribute → styles.xml cellXfs[numFmtId] → a built-in date
 * ID (14–22, 45–47) or a custom format code with y/m/d/h/s tokens.
 *
 * Uses only libraries the app already ships (fflate for the ZIP, cheerio
 * for the XML); no new dependency.
 */

function decode(bytes: Uint8Array | undefined): string {
  if (!bytes) return "";
  return Buffer.from(bytes).toString("utf8");
}

/** Resolve a sheet's worksheet path from the rels (r:id → Target). */
function sheetTargets(zip: Record<string, Uint8Array>): Map<string, string> {
  const map = new Map<string, string>();
  const relsXml = decode(zip["xl/_rels/workbook.xml.rels"]);
  if (!relsXml) return map;
  const $ = load(relsXml, { xmlMode: true });
  $("Relationship").each((_, el) => {
    const id = $(el).attr("Id");
    const target = $(el).attr("Target");
    if (!id || !target) return;
    // Targets are relative to xl/ ("worksheets/sheet1.xml") or absolute.
    map.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  });
  return map;
}

/** Shared strings table: index → text (rich-text runs concatenated). */
function sharedStrings(zip: Record<string, Uint8Array>): string[] {
  const xml = decode(zip["xl/sharedStrings.xml"]);
  if (!xml) return [];
  const $ = load(xml, { xmlMode: true });
  const out: string[] = [];
  $("si").each((_, el) => {
    const runs = $(el)
      .find("t")
      .map((_, t) => $(t).text())
      .get();
    out.push(runs.join(""));
  });
  return out;
}

/**
 * styles.xml → the set of cellXfs indices whose number format is a date.
 * A cell's `s` attribute indexes into cellXfs; that xf's numFmtId is a
 * built-in date/time ID (14–22, 45–47) or a custom format code whose
 * tokens contain y/m/d/h/s (after stripping quoted literals, bracket
 * sections like [$‑409], and backslash escapes).
 */
function dateStyles(zip: Record<string, Uint8Array>): Set<number> {
  const out = new Set<number>();
  const xml = decode(zip["xl/styles.xml"]);
  if (!xml) return out;
  const $ = load(xml, { xmlMode: true });

  const custom = new Map<number, string>();
  $("numFmts numFmt").each((_, el) => {
    const id = Number($(el).attr("numFmtId"));
    const code = $(el).attr("formatCode") ?? "";
    if (Number.isInteger(id) && id > 163) custom.set(id, code);
  });

  const isDateCode = (code: string): boolean => {
    // Elapsed-time formats ([h]:mm:ss) count duration, not a calendar date.
    if (/\[[hms]\]/i.test(code)) return false;
    const bare = code
      .replace(/"[^"]*"/g, "") // quoted literals ("Jul" dd)
      .replace(/\[[^\]]*\]/g, "") // locale/color/condition sections
      .replace(/\\./g, ""); // escaped chars
    return /[ymdhs]/i.test(bare);
  };

  const isDateFmtId = (id: number): boolean =>
    (id >= 14 && id <= 22) ||
    (id >= 45 && id <= 47) ||
    isDateCode(custom.get(id) ?? "");

  let idx = 0;
  $("cellXfs xf").each((_, el) => {
    const numFmtId = Number($(el).attr("numFmtId")) || 0;
    if (isDateFmtId(numFmtId)) out.add(idx);
    idx++;
  });
  return out;
}

/** Excel serial number → ISO date (YYYY-MM-DD). The Excel epoch is
 * 1899-12-30; 25569 is the day offset to the Unix epoch. Time-of-day
 * fractions are dropped (the statement matcher only needs the date). */
function serialToDate(serial: number): string {
  if (!Number.isFinite(serial)) return "";
  const ms = (Math.floor(serial) - 25569) * 86_400_000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** One worksheet → rows of cell values (strings, placed by column ref). */
function parseSheet(
  xml: string,
  shared: string[],
  dates: Set<number>,
): string[][] {
  const $ = load(xml, { xmlMode: true });
  const rows: string[][] = [];
  $("sheetData row").each((_, rowEl) => {
    const cells: string[] = [];
    $(rowEl)
      .find("c")
      .each((_, cEl) => {
        const $c = $(cEl);
        // Column position from the cell reference ("A8" → 0).
        const ref = $c.attr("r") ?? "";
        const letters = ref.match(/^([A-Z]+)/);
        if (letters) {
          let col = 0;
          for (const ch of letters[1]!) {
            col = col * 26 + (ch.charCodeAt(0) - 64);
          }
          col -= 1;
          let val = "";
          const t = $c.attr("t");
          if (t === "s") {
            const v = $c.find("v").first().text();
            const n = Number(v);
            val =
              Number.isInteger(n) && n >= 0 && n < shared.length
                ? shared[n]!
                : v;
          } else if (t === "inlineStr") {
            val = $c
              .find("is t")
              .map((_, tEl) => $(tEl).text())
              .get()
              .join("");
          } else if (dates.has(Number($c.attr("s")) || 0)) {
            val = serialToDate(Number($c.find("v").first().text()));
          } else {
            val = $c.find("v").first().text();
          }
          cells[col] = val;
        }
      });
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    rows.push(cells);
  });
  return rows;
}

// NET-006: a .xlsx is attacker-supplied input (reconcile upload). fflate's
// unzipSync trusts the central directory's declared uncompressed sizes and
// allocates them, so a crafted "zip bomb" (small file declaring multi-GB
// entries) would OOM the function. Pre-scan the central directory and
// reject workbooks whose DECLARED expansion exceeds the budget before any
// decompression; a lying header (actual output > declared) makes fflate
// throw, which the reconcile caller already catches.
const XLSX_MAX_ENTRIES = 200;
const XLSX_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const XLSX_MAX_TOTAL_BYTES = 96 * 1024 * 1024;

/** Walk the ZIP central directory (bounded scan) and sum declared
 * uncompressed sizes. False when the structure is unreadable or the
 * budget is exceeded. */
function zipWithinBudget(
  buffer: Buffer,
  maxEntry = XLSX_MAX_ENTRY_BYTES,
  maxTotal = XLSX_MAX_TOTAL_BYTES,
): boolean {
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  // Locate the End Of Central Directory record (signature 0x06054b50);
  // it may be followed by a zip comment up to 65535 bytes.
  const eocdMin = Math.max(0, buffer.byteLength - 22 - 65535);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= eocdMin; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return false;
  const entryCount = view.getUint16(eocd + 10, true);
  if (entryCount > XLSX_MAX_ENTRIES) return false;
  let offset = view.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > buffer.byteLength) return false;
    if (view.getUint32(offset, true) !== 0x02014b50) return false;
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    // 0xffffffff marks ZIP64 — beyond the budget by definition.
    if (
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      uncompressed > maxEntry
    ) {
      return false;
    }
    total += uncompressed;
    if (total > maxTotal) return false;
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return true;
}

/** Unzip an .xlsx and return every sheet's cells, in workbook order. */
export function parseXlsxSheets(buffer: Buffer): string[][][] {
  if (!zipWithinBudget(buffer)) {
    throw new Error("xlsx exceeds the decompression budget");
  }
  const zip = unzipSync(new Uint8Array(buffer));
  const rels = sheetTargets(zip);
  const shared = sharedStrings(zip);
  const dates = dateStyles(zip);

  const sheets: string[][][] = [];
  const workbookXml = decode(zip["xl/workbook.xml"]);
  if (!workbookXml) return sheets;
  const $ = load(workbookXml, { xmlMode: true });
  $("sheets sheet").each((_, el) => {
    const id = $(el).attr("r:id") ?? "";
    const target = rels.get(id);
    if (!target) return;
    const xml = decode(zip[target]);
    if (!xml) return;
    sheets.push(parseSheet(xml, shared, dates));
  });
  return sheets;
}
