import {
  deleteImage,
  imageResponseHeaders,
  readImage,
  readUploadedFile,
  saveImage,
  uploadErrorMessage,
} from "~/lib/images.server";
import { requireUser } from "~/lib/auth.server";
import { captureWarning } from "~/lib/errors.server";
import {
  extractUploadedReceiptFields,
  prepareUploadedReceipt,
} from "~/lib/receipt-ocr.server";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/api.expense";

/** OCR + extraction can take ~10-15s (DeepSeek, or tesseract on first run). */
export const config = { maxDuration: 15 };

/**
 * Serve a draft receipt image. Drafts live under temporary keys with no
 * expense row, so there is no /expense/:id/image route for them — the editor
 * fetches this URL to show the rasterized preview of a PDF upload (an <img>
 * can't render a PDF blob). Scoped to the caller's account like every read.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const key = url.searchParams.get("draftKey");
  if (!key) return new Response("Not found", { status: 404 });
  const image = await readImage(user.accountId, key);
  if (!image) return new Response("Not found", { status: 404 });
  return new Response(image.buffer as BodyInit, {
    headers: imageResponseHeaders(
      image.mime || "image/png",
      "public, max-age=300",
    ),
  });
}

/**
 * Receipt image drafts — the home page's "Add receipt" opens the editor
 * without creating anything, so an uploaded/pasted image has nowhere to live
 * until Save. These intents store the image blob (and OCR it) without an
 * expense row; the editor's Save action attaches the draft to the new
 * expense, and Cancel deletes it.
 */
export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = formString(form, "intent");

  if (intent === "draft-upload") {
    const uploaded = await readUploadedFile(form);
    if (!uploaded.ok) {
      return Response.json(
        { error: uploadErrorMessage(uploaded.error) },
        { status: 400 },
      );
    }
    // PDFs are rasterized to PNG before they can be displayed or stored (the
    // editor renders receipts as <img>). The draft is saved immediately —
    // OCR never blocks the upload, so a slow scan or timeout can't prevent
    // it (the editor runs a separate "ocr" request for the fields, for
    // images and PDFs alike). Only an unreadable PDF fails the upload.
    const prepared = await prepareUploadedReceipt(uploaded, "draft-upload");
    if (prepared === null) {
      return Response.json(
        { error: "Couldn't read that PDF." },
        { status: 400 },
      );
    }
    const saved = await saveImage(
      user.accountId,
      prepared.buffer,
      prepared.mime,
      prepared.originalName,
    );
    // No expense row is created — the draft is just a stored blob; the
    // editor's "ocr" request extracts and pre-fills the fields.
    return Response.json({
      ok: true,
      draftKey: saved.filename,
      mime: saved.mime,
      originalName: prepared.originalName,
    });
  }

  if (intent === "draft-delete") {
    const draftKey = formString(form, "draftKey");
    if (draftKey) await deleteImage(user.accountId, draftKey);
    return Response.json({ ok: true });
  }

  if (intent === "ocr" || intent === "draft-ocr") {
    // OCR a just-uploaded receipt file and return the extracted fields so
    // the editor can fill them in. PDFs store their draft before OCR
    // finishes (see draft-upload); this intent re-runs extraction on the
    // original file so the editor's fields fill in when the scan is ready.
    // A failure only loses the fields — the draft or image is already
    // stored — so the response is always ok. "draft-ocr" is the legacy
    // name; both work.
    const uploaded = await readUploadedFile(form);
    if (!uploaded.ok) {
      return Response.json(
        { error: uploadErrorMessage(uploaded.error) },
        { status: 400 },
      );
    }
    const { buffer, mime } = uploaded;
    try {
      const ocr = await extractUploadedReceiptFields(
        user.accountId,
        buffer,
        mime,
      );
      return Response.json({
        ok: true,
        merchant: ocr.merchant,
        amount: ocr.amount,
        category: ocr.category,
        report: ocr.report,
      });
    } catch (err) {
      captureWarning("[ocr] receipt extraction failed", { error: err });
      return Response.json({
        ok: true,
        merchant: "",
        amount: "",
        category: "",
        report: "",
      });
    }
  }

  return unknownIntent();
}
