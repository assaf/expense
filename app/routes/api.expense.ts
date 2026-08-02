import { deleteImage, readUploadedFile, saveImage } from "~/lib/images.server";
import { requireUser } from "~/lib/auth.server";
import { readCategories } from "~/lib/store.server";
import { extractFromImage } from "~/lib/receipt-ocr.server";
import { matchCategory } from "~/lib/receipt-ai.server";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/api.expense";

/** OCR + extraction can take a while (DeepSeek, or tesseract on first run). */
export const config = { maxDuration: 60 };

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
 * account already uses. Throws when extraction fails — callers decide whether
 * that is fatal (it isn't for drafts).
 */
async function extractFromUploadedImage(
  accountId: string,
  buffer: Buffer,
  mime: string,
): Promise<{ merchant: string; amount: string; category: string }> {
  const categories = (await readCategories(accountId)).map((c) => c.name);
  const { result } = await extractFromImage({ buffer, mime, categories });
  return {
    merchant: result.merchant,
    amount: result.amount,
    category: matchCategory(result.category, categories),
  };
}
