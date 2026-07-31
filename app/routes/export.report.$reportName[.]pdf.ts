import { Writable } from "node:stream";
import PDFDocument from "pdfkit";
import { requireUser } from "~/lib/auth.server";
import { readExpenses, readReports } from "~/lib/store.server";
import { readSettings } from "~/lib/settings.server";
import { readImage } from "~/lib/images.server";
import { formatDate, mileageMerchant, yearOf } from "~/lib/format";
import type { Expense } from "~/lib/types";
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

  const inReport = expenses
    .filter((e) => e.report === reportName)
    .sort((a, b) => a.date.localeCompare(b.date));

  const doc = new PDFDocument({ margin: 50, size: "LETTER" });
  const stream = collectStream(doc);

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
      const merchant = merchantLabel(e, settings.mileageRates);
      const date = formatDate(e.date);
      const amount = e.amount ? `$${e.amount}` : "—";
      const desc = e.description ?? "";

      // Keep the whole row on one page.
      doc.fontSize(10).font("Helvetica").fillColor("#111827");
      if (doc.y + doc.currentLineHeight() > doc.page.maxY()) {
        doc.addPage();
      }
      const rowY = doc.y;
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
      doc.moveDown(0.3);
    }
    // Extra breathing room before the next category.
    doc.moveDown(0.75);
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
    for (const e of receipts) {
      const image = await readImage(e.imageFile);
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
      doc.addPage();
    }
  }

  doc.end();
  await stream.done;

  return new Response(stream.value as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename(reportName)}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}

function merchantLabel(e: Expense, rates: Record<string, string>): string {
  if (e.type === "receipt") return e.merchant || "—";
  return mileageMerchant(e.distanceMiles, rates[yearOf(e.date)] ?? "");
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

function filename(report: string): string {
  return report.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

/** Collect a PDFKit document's output into a Buffer. */
function collectStream(doc: PDFKit.PDFDocument) {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  doc.pipe(stream);
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  stream.on("finish", () => resolve());
  return {
    done,
    get value() {
      return Buffer.concat(chunks);
    },
  };
}
