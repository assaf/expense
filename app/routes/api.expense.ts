import { isPdf } from "~/lib/file-types";
import {
  deleteImage,
  readImage,
  readUploadedFile,
  saveImage,
} from "~/lib/images.server";
import { requireUser } from "~/lib/auth.server";
import { readExtractionContext } from "~/lib/store.server";
import { extractFromImage, rasterizePdfUpload } from "~/lib/receipt-ocr.server";
import { resolveCategory } from "~/lib/receipt-ai.server";
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
    // editor renders receipts as <img>). The draft is saved immediately after
    // rendering — OCR never blocks it, so a slow scan or OCR timeout can't
    // prevent the upload (the editor runs a separate draft-ocr request for
    // the fields). Only an unreadable PDF fails the upload.
    if (isPdf(uploaded)) {
      let pdf: { buffer: Buffer; mime: "image/png"; originalName: string };
      try {
        pdf = await rasterizePdfUpload(uploaded);
      } catch (err) {
        console.warn("[draft-upload] PDF render failed:", err);
        return Response.json(
          { error: "Couldn't read that PDF." },
          { status: 400 },
        );
      }
      const saved = await saveImage(
        user.accountId,
        pdf.buffer,
        pdf.mime,
        pdf.originalName,
      );
      return Response.json({
        ok: true,
        draftKey: saved.filename,
        mime: saved.mime,
        originalName: pdf.originalName,
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

  if (intent === "draft-ocr") {
    // PDFs store their draft before OCR finishes (see draft-upload); this
    // intent re-runs extraction on the original file so the editor's fields
    // fill in when the scan is ready. A failure only loses the fields — the
    // draft is already stored — so the response is always ok.
    const uploaded = await readUploadedFile(form);
    if (!uploaded) {
      return Response.json({ error: "No image received." }, { status: 400 });
    }
    const { buffer, mime } = uploaded;
    try {
      const ocr = await extractFromUploadedImage(user.accountId, buffer, mime);
      return Response.json({
        ok: true,
        merchant: ocr.merchant,
        amount: ocr.amount,
        category: ocr.category,
      });
    } catch (err) {
      console.warn("[draft-ocr] receipt extraction failed:", err);
      return Response.json({
        ok: true,
        merchant: "",
        amount: "",
        category: "",
      });
    }
  }

  return unknownIntent();
}

/**
 * OCR an uploaded receipt image and fill in the fields: merchant and amount
 * straight from the extraction, and the category as the merchant's previous
 * category when one exists (a merchant the user already categorized is
 * reused, not re-guessed), else the suggested category mapped onto one the
 * account already uses. Throws when extraction fails — callers decide
 * whether that is fatal (it isn't for drafts).
 */
async function extractFromUploadedImage(
  accountId: string,
  buffer: Buffer,
  mime: string,
): Promise<{ merchant: string; amount: string; category: string }> {
  const { categories, merchantCategories } =
    await readExtractionContext(accountId);
  const { result } = await extractFromImage({ buffer, mime, categories });
  return {
    merchant: result.merchant,
    amount: result.amount,
    category: resolveCategory(
      result.merchant,
      result.category,
      merchantCategories,
      categories,
    ),
  };
}
