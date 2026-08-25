import PDFDocument from "pdfkit";
import { readImage } from "~/lib/images.server";
import { pdfToBuffer } from "~/lib/pdf.server";
import { formatDate, mileageDistanceLabel, sortExpenses } from "~/lib/format";
import {
  MILEAGE_TYPE_LABELS,
  mileageRateFor,
  mileageRateLabel,
  type MileageRateEntry,
} from "~/lib/mileage-rates";
import { renderRouteMap } from "~/lib/route-map.server";
import type { Expense, MileageExpense } from "~/lib/types";

/**
 * Build the PDF for one report, the same layout the /export/report/:name
 * download uses, extracted so the MCP `export_report` tool can reuse it.
 *
 * Grouped by category (chronological within each), with a receipts image
 * appendix. Mileage rows show the IRS type and rate, the distance, and an
 * embedded route map of the trip. Base-14 PDF fonts can't encode "→", so
 * routes use "›".
 */
export async function buildReportPdf(
  accountId: string,
  reportName: string,
  expenses: Expense[],
  rates: MileageRateEntry[],
): Promise<Buffer> {
  const inReport = sortExpenses(
    expenses.filter((e) => e.report === reportName),
    false,
  );

  const doc = new PDFDocument({ margin: 50, size: "LETTER" });
  const pdf = pdfToBuffer(doc);

  // Title
  doc.fontSize(20).font("Helvetica-Bold").text(reportName, { align: "left" });
  doc.moveDown(0.5);
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#6b7280")
    .text(`Generated ${new Date().toLocaleDateString("en-US")}`, {
      align: "left",
    });
  doc.moveDown(1);
  doc.fillColor("#111827");

  // Group by category (expenses with no category under "No category"),
  // chronological within each group; every expense in the report appears.
  const NO_CATEGORY = "No category";
  const categoryOf = (e: Expense) => e.category || NO_CATEGORY;
  const categories = uniqueSorted(inReport.map(categoryOf));

  // Fixed table columns: Date | Amount | Merchant | Description, with gutters.
  const dateX = 50,
    amountX = 134,
    merchantX = 197,
    descX = 330;
  const dateW = 72,
    amountW = 55,
    merchantW = 125,
    descW = 562 - descX;

  for (const category of categories) {
    doc.moveDown(0.75);
    // Don't orphan a category title at the very bottom of a page.
    if (doc.y > doc.page.maxY() - 2 * doc.currentLineHeight()) {
      doc.addPage();
    }
    doc
      .fontSize(13)
      .font("Helvetica-Bold")
      .text(category, 50, doc.y, { width: 512, align: "center" });
    doc.moveDown(0.25);
    const inCat = inReport.filter((e) => categoryOf(e) === category);
    for (const e of inCat) {
      const isMileage = e.type === "mileage";
      let merchant: string;
      let route = "";
      if (isMileage) {
        // The IRS type and the rate for the trip's (date, type); the actual
        // mileage and amount are the distance line and the amount column.
        // The route map lives in the appendix (Receipts & routes).
        const rate = mileageRateFor(rates, e.date, e.mileageType);
        merchant = rate
          ? mileageRateLabel(e.mileageType, rate)
          : MILEAGE_TYPE_LABELS[e.mileageType];
        const addresses = e.locations
          .map((l) => l.address.trim())
          .filter(Boolean);
        // Second line: distance + route addresses (Start › … › Start
        // implied).
        route = [mileageDistanceLabel(e.distanceMiles), addresses.join(" › ")]
          .filter(Boolean)
          .join(" — ");
      } else {
        merchant = e.merchant || "—";
      }
      const date = formatDate(e.date);
      const amount = e.amount ? `$${e.amount}` : "—";
      const desc = e.description ?? "";

      // Keep the whole row (including the route line) on one page.
      const lineH = doc.fontSize(10).currentLineHeight();
      const rowH = lineH + (route ? lineH + 4 : 0);
      if (doc.y + rowH > doc.page.maxY()) {
        doc.addPage();
      }
      const rowY = doc.y;
      doc.font("Helvetica").fillColor("#111827");
      doc.text(date, dateX, rowY, { width: dateW, lineBreak: false });
      doc.text(amount, amountX, rowY, {
        width: amountW,
        lineBreak: false,
        align: "right",
      });
      doc.text(fitText(doc, merchant, merchantW, 20), merchantX, rowY, {
        width: merchantW,
        lineBreak: false,
      });
      if (desc) {
        doc.fillColor("#4b5563").text(fitText(doc, desc, descW), descX, rowY, {
          width: descW,
          lineBreak: false,
        });
        doc.fillColor("#111827");
      }
      if (route) {
        doc
          .fontSize(8)
          .fillColor("#6b7280")
          .text(fitText(doc, route, descW + descX - dateX), dateX, doc.y + 1, {
            width: descW + descX - dateX,
            lineBreak: false,
          });
        doc.fillColor("#111827");
      }
      doc.moveDown(0.3);
    }
    // Extra breathing room before the next category.
    doc.moveDown(0.75);
  }

  // Receipt images + mileage route maps appendix.
  const receipts = inReport.filter(
    (e): e is Extract<Expense, { type: "receipt" }> =>
      e.type === "receipt" && Boolean(e.imageFile),
  );
  const routes: { e: MileageExpense; map: Buffer }[] = [];
  for (const e of inReport) {
    if (e.type !== "mileage") continue;
    // A render failure must never break the export.
    try {
      const map = await renderRouteMap(e);
      if (map) routes.push({ e, map });
    } catch {
      // Skip the map for this trip.
    }
  }
  if (receipts.length > 0 || routes.length > 0) {
    doc.addPage();
    doc.fontSize(13).font("Helvetica-Bold").text("Receipts & routes");
    doc.moveDown(0.5);
    let firstItem = true;
    const pageForNext = () => {
      // One item per page, but no trailing blank page after the last.
      if (!firstItem) doc.addPage();
      firstItem = false;
    };
    for (const e of receipts) {
      pageForNext();
      const image = await readImage(accountId, e.imageFile);
      if (!image) continue;
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#4b5563")
        .text(`${formatDate(e.date)} — ${e.merchant || e.imageFile}`);
      doc.fillColor("#111827");
      try {
        doc.image(image.buffer, { fit: [500, 650], align: "center" });
      } catch {
        doc
          .fontSize(9)
          .fillColor("#9ca3af")
          .text("(image could not be embedded)");
        doc.fillColor("#111827");
      }
    }
    // Mileage route maps: the real map with the date, mileage, and amount
    // listed beside it, and the trip's stops listed below.
    for (const { e, map } of routes) {
      pageForNext();
      const mapW = 380;
      const mapH = 182;
      const textX = 50 + mapW + 16;
      const textW = 512 - textX;
      // doc.image with an explicit y does NOT advance doc.y, and the field
      // text calls reset it too; position the stops below the map
      // explicitly so they land under it, not on top of it.
      const mapTop = doc.y;
      doc.image(map, 50, mapTop, { fit: [mapW, mapH] });
      let ty = mapTop;
      const fields: [string, string][] = [
        ["Date", formatDate(e.date)],
        ["Mileage", e.distanceMiles ? `${e.distanceMiles} miles` : "—"],
        ["Amount", e.amount ? `$${e.amount}` : "—"],
      ];
      for (const [label, value] of fields) {
        doc
          .fontSize(8)
          .fillColor("#6b7280")
          .text(label, textX, ty, { width: textW, lineBreak: false });
        doc
          .fontSize(11)
          .fillColor("#111827")
          .text(value, textX, ty + 10, { width: textW, lineBreak: false });
        ty += 28;
      }
      doc.fillColor("#111827");
      doc.y = mapTop + mapH;

      // The trip's stops, in route order, under the map (no header; the
      // placement makes it obvious they belong to the trip).
      const locations = e.locations
        .map((l) => l.address.trim())
        .filter(Boolean);
      if (locations.length > 0) {
        doc.moveDown(0.5);
        const locH = locations.length * 13;
        // Don't run past the page bottom: a long list moves to its own
        // page rather than clipping.
        if (doc.y + locH > doc.page.maxY()) doc.addPage();
        for (const [i, address] of locations.entries()) {
          const label = i === 0 ? "Start/end" : `Stop ${i}`;
          const ly = doc.y;
          doc
            .fontSize(9)
            .fillColor("#6b7280")
            .text(label, 50, ly, { width: 70, lineBreak: false });
          doc
            .fillColor("#111827")
            .text(fitText(doc, address, 512 - 130), 130, ly, {
              width: 512 - 130,
              lineBreak: false,
            });
          doc.moveDown(0.3);
        }
      }
    }
  }

  doc.end();
  return pdf;
}

/**
 * Truncate text so it fits maxWidth. When maxChars is given, text is capped
 * at that many characters. An ellipsis is appended whenever text was cut,
 * and width is measured so the ellipsis always fits.
 */
function fitText(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
  maxChars?: number,
): string {
  let t = text;
  if (maxChars !== undefined) t = t.slice(0, maxChars);
  if (doc.widthOfString(t) <= maxWidth) {
    return t === text ? t : `${t.slice(0, -1)}…`;
  }
  while (t.length > 1 && doc.widthOfString(`${t}…`) > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}…`;
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}
