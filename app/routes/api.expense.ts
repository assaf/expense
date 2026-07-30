import { saveImage } from "~/lib/images.server";
import { initStore, newExpenseShell, upsertExpense } from "~/lib/store.server";
import type { ReceiptExpense } from "~/lib/types";
import { formString } from "~/lib/validation";
import type { Route } from "./+types/api.expense";

/** Create a new expense (receipt or mileage), or a receipt from an uploaded image. */
export async function action({ request }: Route.ActionArgs) {
  await initStore();
  const form = await request.formData();
  const intent = formString(form, "intent");

  if (intent === "create") {
    const type = formString(form, "type") as "receipt" | "mileage";
    const expense = newExpenseShell(type);
    await upsertExpense(expense);
    return Response.json({ ok: true, id: expense.id });
  }

  if (intent === "upload") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json({ error: "No image received." }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const { filename, mime } = await saveImage(
      buffer,
      file.type,
      file.name || "pasted.png",
    );
    const expense = newExpenseShell("receipt") as ReceiptExpense;
    expense.imageFile = filename;
    expense.imageMime = mime;
    expense.originalName = file.name || "pasted.png";
    await upsertExpense(expense);
    return Response.json({ ok: true, id: expense.id });
  }

  return Response.json({ error: "Unknown intent." }, { status: 400 });
}
