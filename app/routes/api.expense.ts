import { saveImage } from "~/lib/images.server";
import { requireUser } from "~/lib/auth.server";
import {
  initStore,
  newExpenseShell,
  readCategories,
  upsertExpense,
} from "~/lib/store.server";
import { extractFromImage } from "~/lib/receipt-ocr.server";
import { matchCategory } from "~/lib/receipt-ai.server";
import type { ReceiptExpense } from "~/lib/types";
import { formString } from "~/lib/validation";
import type { Route } from "./+types/api.expense";

/** OCR + extraction can take a while (DeepSeek, or tesseract on first run). */
export const config = { maxDuration: 60 };

/** Create a new expense (receipt or mileage), or a receipt from an uploaded image. */
export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  await initStore();
  const form = await request.formData();
  const intent = formString(form, "intent");

  if (intent === "create") {
    const type = formString(form, "type") as "receipt" | "mileage";
    const expense = newExpenseShell(type);
    await upsertExpense(expense, user.accountId);
    return Response.json({ ok: true, id: expense.id });
  }

  if (intent === "upload") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json({ error: "No image received." }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = file.type || "image/png";
    const originalName = file.name || "pasted.png";

    // Save the image and OCR it in parallel. The expense is always created;
    // extraction just pre-fills merchant, amount, and category when possible.
    const [ocr, saved] = await Promise.all([
      extractFromUploadedImage(user.accountId, buffer, mime).catch((err) => {
        console.warn("[upload] receipt extraction failed:", err);
        return null;
      }),
      saveImage(user.accountId, buffer, mime, originalName),
    ]);

    const expense = newExpenseShell("receipt") as ReceiptExpense;
    expense.imageFile = saved.filename;
    expense.imageMime = saved.mime;
    expense.originalName = originalName;
    if (ocr) {
      expense.merchant = ocr.merchant;
      expense.amount = ocr.amount;
      expense.category = ocr.category;
    }
    await upsertExpense(expense, user.accountId);
    return Response.json({ ok: true, id: expense.id });
  }

  return Response.json({ error: "Unknown intent." }, { status: 400 });
}

/**
 * OCR an uploaded receipt image and map the suggested category onto one the
 * account already uses. Throws when extraction fails — callers decide whether
 * that is fatal (it isn't for uploads).
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
