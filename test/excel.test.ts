import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseXlsxSheets } from "~/lib/excel.server";
import { parseStatementUpload } from "~/lib/reconcile.server";

/**
 * parseXlsxSheets must turn real Excel date cells (serial numbers with a
 * date number-format) into ISO dates instead of leaking the raw serial.
 * The fixtures here are built by hand — fflate zips the OOXML parts — so a
 * date column can be exercised without shipping a binary fixture.
 */

function buildXlsx(parts: Record<string, string>): Buffer {
  const files: Record<string, Uint8Array> = {};
  for (const [path, xml] of Object.entries(parts)) {
    files[path] = strToU8(xml);
  }
  return Buffer.from(zipSync(files));
}

const SHELL: Record<string, string> = {
  "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`,
  "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
};

const STYLES = (extraNumFmts: string, xfs: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">${extraNumFmts}</numFmts>
  <cellXfs count="4">${xfs}</cellXfs>
</styleSheet>`;

const SHEET = (rows: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rows}</sheetData>
</worksheet>`;

describe("parseXlsxSheets date cells", () => {
  it("converts built-in and custom date formats, leaves numbers and text alone", () => {
    const xlsx = buildXlsx({
      ...SHELL,
      "xl/styles.xml": STYLES(
        `<numFmt numFmtId="164" formatCode="m/d/yyyy"/>
         <numFmt numFmtId="165" formatCode="[h]:mm:ss"/>`,
        `<xf numFmtId="0"/>
         <xf numFmtId="14" applyNumberFormat="1"/>
         <xf numFmtId="164" applyNumberFormat="1"/>
         <xf numFmtId="165" applyNumberFormat="1"/>`,
      ),
      "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">
  <si><t>01/15/2026</t></si>
</sst>`,
      "xl/worksheets/sheet1.xml": SHEET(
        `<row r="1">
           <c r="A1" s="1"><v>46037</v></c>
           <c r="B1" s="2"><v>46215</v></c>
           <c r="C1" s="3"><v>1.5</v></c>
           <c r="D1"><v>1234.56</v></c>
           <c r="E1" t="s"><v>0</v></c>
         </row>`,
      ),
    });

    expect(parseXlsxSheets(xlsx)).toEqual([
      [["2026-01-15", "2026-07-12", "1.5", "1234.56", "01/15/2026"]],
    ]);
  });

  it("keeps plain numeric cells as raw numbers", () => {
    const xlsx = buildXlsx({
      ...SHELL,
      "xl/styles.xml": STYLES("", `<xf numFmtId="0"/>`),
      "xl/worksheets/sheet1.xml": SHEET(
        `<row r="1"><c r="A1"><v>42</v></c></row>`,
      ),
    });

    expect(parseXlsxSheets(xlsx)).toEqual([[["42"]]]);
  });
});

describe("statement parsing with Excel date cells", () => {
  it("maps a real date column through to the statement row", async () => {
    const xlsx = buildXlsx({
      ...SHELL,
      "xl/styles.xml": STYLES(
        "",
        `<xf numFmtId="0"/>
         <xf numFmtId="14" applyNumberFormat="1"/>`,
      ),
      "xl/worksheets/sheet1.xml": SHEET(
        `<row r="1">
           <c r="A1" t="inlineStr"><is><t>Date</t></is></c>
           <c r="B1" t="inlineStr"><is><t>Description</t></is></c>
           <c r="C1" t="inlineStr"><is><t>Amount</t></is></c>
         </row>
         <row r="2">
           <c r="A2" s="1"><v>46037</v></c>
           <c r="B2" t="inlineStr"><is><t>Coffee</t></is></c>
           <c r="C2"><v>-4.50</v></c>
         </row>`,
      ),
    });

    const { rows, skipped } = await parseStatementUpload("stmt.xlsx", xlsx);
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-01-15",
      description: "Coffee",
      amount: "4.50",
      direction: "charge",
      source: "xlsx",
    });
  });
});
