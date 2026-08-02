/**
 * Collect a PDFKit document's output into a Buffer. Callers build the
 * document, then call `doc.end()` and await the promise. Shared by the
 * report PDF export and the post-deploy smoke check.
 */
export function pdfToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
