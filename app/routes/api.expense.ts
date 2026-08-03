import {
  deleteImage,
  isPdfUpload,
  pdfImageName,
  readImage,
  readUploadedFile,
  saveImage,
} from "~/lib/images.server";
import { requireUser } from "~/lib/auth.server";
import { readCategories } from "~/lib/store.server";
import { extractFromImage, renderPdfToPng } from "~/lib/receipt-ocr.server";
import { matchCategory } from "~/lib/receipt-ai.server";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/api.expense";

/** OCR + extraction can take a while (DeepSeek, or tesseract on first run). */
export const config = { maxDuration: 60 };

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
    headers: { "Content-Type": image.mime || "image/png" },
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
    if (!uploaded) {
      return Response.json({ error: "No image received." }, { status: 400 });
    }
    const { buffer, mime, originalName } = uploaded;

    // PDFs are rasterized to PNG before they can be displayed or stored (the
    // editor renders receipts as <img>). Extraction runs first so its rendered
    // PNG is reused for storage; when extraction fails (e.g. the AI API being
    // down) the render is still stored, so the draft survives and the user can
    // fill the fields by hand. Only an unreadable PDF fails the upload.
    if (isPdfUpload(uploaded)) {
      let ocr: Awaited<ReturnType<typeof extractFromUploadedImage>> | null =
        null;
      try {
        ocr = await extractFromUploadedImage(user.accountId, buffer, mime);
      } catch (err) {
        console.warn("[draft-upload] PDF extraction failed:", err);
      }
      let png: Buffer | null = null;
      if (ocr) {
        png = ocr.stored.buffer;
      } else {
        try {
          png = await renderPdfToPng(buffer);
        } catch (err) {
          console.warn("[draft-upload] PDF render failed:", err);
        }
      }
      if (!png) {
        return Response.json(
          { error: "Couldn't read that PDF." },
          { status: 400 },
        );
      }
      const storedName = pdfImageName(originalName);
      const saved = await saveImage(
        user.accountId,
        png,
        "image/png",
        storedName,
      );
      return Response.json({
        ok: true,
        draftKey: saved.filename,
        mime: saved.mime,
        originalName: storedName,
        merchant: ocr?.merchant ?? "",
        amount: ocr?.amount ?? "",
        category: ocr?.category ?? "",
      });
    }

    // Save the image and OCR it in parallel. No expense row is created —
    // extraction just pre-fills the draft editor when it succeeds.
    const [ocr, saved] = await Promise.all([
      extractFromUploadedImage(user.accountId, buffer, mime).catch((err) => {
        console.warn("[draft-upload] receipt extraction failed:", err);
        return null;
      }),
      saveImage(user.accountId, buffer, mime, originalName),
    ]);

    return Response.json({
      ok: true,
      draftKey: saved.filename,
      mime: saved.mime,
      originalName,
      merchant: ocr?.merchant ?? "",
      amount: ocr?.amount ?? "",
      category: ocr?.category ?? "",
    });
  }

  if (intent === "draft-delete") {
    const draftKey = formString(form, "draftKey");
    if (draftKey) await deleteImage(user.accountId, draftKey);
    return Response.json({ ok: true });
  }

  return unknownIntent();
}

/**
 * OCR an uploaded receipt image and map the suggested category onto one the
 * account already uses. Returns the browser-friendly stored image too, so
 * callers that must rasterize (PDFs) don't render twice. Throws when
 * extraction fails — callers decide whether that is fatal (it isn't for
 * drafts).
 */
async function extractFromUploadedImage(
  accountId: string,
  buffer: Buffer,
  mime: string,
): Promise<{
  merchant: string;
  amount: string;
  category: string;
  stored: { buffer: Buffer; mime: string };
}> {
  const categories = (await readCategories(accountId)).map((c) => c.name);
  const { result, stored } = await extractFromImage({
    buffer,
    mime,
    categories,
  });
  return {
    merchant: result.merchant,
    amount: result.amount,
    category: matchCategory(result.category, categories),
    stored,
  };
}
