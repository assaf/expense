import { unzipSync } from "fflate";
import { load } from "cheerio";

/**
 * Minimal .xlsx (OOXML spreadsheet) reader — enough for bank statement
 * exports. An .xlsx is a ZIP of XML: workbook.xml lists the sheets,
 * workbook.xml.rels maps each sheet's r:id to its worksheet file,
 * sharedStrings.xml holds the shared text, and each worksheet has the
 * grid of cells. Cells are resolved to plain strings (shared strings,
 * numbers, inline strings), placed by their column reference so sparse
 * rows come out right, with trailing empties trimmed.
 *
 * Excel date cells (serial numbers with a date number-format) are not
 * converted — bank statement exports use text dates; the numbers would
 * surface as unparseable and be reported as skipped lines.
 *
 * Uses only libraries the app already ships (fflate for the ZIP, cheerio
 * for the XML) — no new dependency.
 */

const SPREADSHEET_NS =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

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

/** One worksheet → rows of cell values (strings, placed by column ref). */
function parseSheet(xml: string, shared: string[]): string[][] {
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

/** Unzip an .xlsx and return every sheet's cells, in workbook order. */
export function parseXlsxSheets(buffer: Buffer): string[][][] {
  const zip = unzipSync(new Uint8Array(buffer));
  const rels = sheetTargets(zip);
  const shared = sharedStrings(zip);

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
    sheets.push(parseSheet(xml, shared));
  });
  return sheets;
}
