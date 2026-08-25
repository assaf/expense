/**
 * pdfjs-dist ships type declarations only for its main entry (pdf.mjs), not
 * for its worker module. `receipt-ocr.server.ts` statically imports the
 * worker so the serverless bundle ships it (see the `globalThis.pdfjsWorker`
 * note there). The worker's `WorkerMessageHandler` is what pdfjs's main-thread
 * fake worker runs the document parsing with.
 *
 * This file is a global script (no import/export) deliberately: ambient
 * module declarations in module-style .d.ts files are ignored when the
 * specifier resolves to a real file, which breaks the worker typing.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}

/** pdfjs reads `globalThis.pdfjsWorker.WorkerMessageHandler` to run its fake
 * worker on the main thread without loading the worker file. */
declare var pdfjsWorker: { WorkerMessageHandler: unknown } | undefined;
