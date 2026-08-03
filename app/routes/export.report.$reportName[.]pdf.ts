import PDFDocument from "pdfkit";
import { requireUser } from "~/lib/auth.server";
import { readExpenses, readReports } from "~/lib/store.server";
import { readSettings } from "~/lib/settings.server";
import { readImage } from "~/lib/images.server";
import { renderRouteMap } from "~/lib/map-image.server";
import { pdfToBuffer } from "~/lib/pdf.server";
import { formatDate, merchantLabel, sortExpenses } from "~/lib/format";
import { geocodedLocations, type Expense } from "~/lib/types";
import { sanitizeFilenamePart } from "~/lib/validation";
import type { Route } from "./+types/export.report.$reportName[.]pdf";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const reportName = params.reportName;
  const [expenses, settings, reports] = await Promise.all([
    readExpenses(user.accountId),
    readSettings(user.accountId),
    readReports(user.accountId),
  ]);
  // Validate the report exists (avoid generating PDFs for arbitrary names).
  if (!reports.some((r) => r.name === reportName)) {
    return new Response("Report not found", { status: 404 });
  }

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

  // Group by category, chronological within each group.
  const categories = uniqueSorted(
    inReport.map((e) => e.category).filter(Boolean),
  );

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
    const inCat = inReport.filter((e) => e.category === category);
    for (const e of inCat) {
      const isMileage = e.type === "mileage";
      const merchant =
        merchantLabel(e, settings.mileageRates) ||
        (isMileage ? "Mileage" : "—");
      const date = formatDate(e.date);
      const amount = e.amount ? `$${e.amount}` : "—";
      const desc = e.description ?? "";
      // Mileage rows get a second line with the route (Start › … › Start
      // implied), so the trip is visible even without a rate or a map.
      // (PDF's base-14 fonts can't encode "→", so routes use "›".)
      const route = isMileage
        ? e.locations
            .map((l) => l.address.trim())
            .filter(Boolean)
            .join(" › ")
        : "";

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
      doc.text(
        fitText(doc, merchant, merchantW, isMileage ? undefined : 20),
        merchantX,
        rowY,
        { width: merchantW, lineBreak: false },
      );
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

  // Mileage routes appendix: a rendered route map per trip (2+ geocoded
  // stops); a trip without coordinates falls back to the text summary only.
  const mileages = inReport.filter(
    (e): e is Extract<Expense, { type: "mileage" }> => e.type === "mileage",
  );
  if (mileages.length > 0) {
    doc.addPage();
    doc.fontSize(13).font("Helvetica-Bold").text("Mileage routes");
    doc.moveDown(0.5);
    for (const [i, e] of mileages.entries()) {
      // One page per trip — but no trailing blank page after the last one.
      if (i > 0) doc.addPage();
      const label = merchantLabel(e, settings.mileageRates) || "Mileage";
      const route = e.locations
        .map((l) => l.address.trim())
        .filter(Boolean)
        .join(" › ");
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#4b5563")
        .text(
          [formatDate(e.date), label, ...(route ? [route] : [])].join(" — "),
        );
      doc.fillColor("#111827");
      if (geocodedLocations(e.locations).length >= 2) {
        try {
          const png = await renderRouteMap(e.locations);
          doc.image(png, { fit: [500, 300], align: "center" });
        } catch {
          // The text summary above stands on its own — never embed a
          // broken or blank map.
        }
      }
    }
  }

  // Receipt images appendix.
  const receipts = inReport.filter(
    (e): e is Extract<Expense, { type: "receipt" }> =>
      e.type === "receipt" && Boolean(e.imageFile),
  );
  if (receipts.length > 0) {
    doc.addPage();
    doc.fontSize(13).font("Helvetica-Bold").text("Receipts");
    doc.moveDown(0.5);
    for (const [i, e] of receipts.entries()) {
      // One page per receipt — but no trailing blank page after the last.
      if (i > 0) doc.addPage();
      const image = await readImage(user.accountId, e.imageFile);
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
  }

  doc.end();

  return new Response((await pdf) as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${sanitizeFilenamePart(reportName)}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
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
