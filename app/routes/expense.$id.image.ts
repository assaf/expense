import {
  renameImageToConvention,
  readImage,
  saveImage,
  deleteImage,
} from "~/lib/images.server";
import { requireUser } from "~/lib/auth.server";
import { readExpense, upsertExpense } from "~/lib/store.server";
import { formString } from "~/lib/validation";
import type { Route } from "./+types/expense.$id.image";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const expense = await readExpense(params.id, user.accountId);
  if (!expense || expense.type !== "receipt" || !expense.imageFile) {
    return new Response("Not found", { status: 404 });
  }
  const image = await readImage(user.accountId, expense.imageFile);
  if (!image) return new Response("Not found", { status: 404 });
  return new Response(image.buffer as BodyInit, {
    headers: {
      "Content-Type": image.mime || expense.imageMime || "image/png",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** Replace or clear the receipt image without reloading the editor. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireUser(request);
  const expense = await readExpense(params.id, user.accountId);
  if (!expense || expense.type !== "receipt") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const form = await request.formData();
  const intent = formString(form, "intent");

  if (intent === "delete") {
    if (expense.imageFile) await deleteImage(user.accountId, expense.imageFile);
    expense.imageFile = "";
    expense.imageMime = "";
    expense.originalName = "";
    expense.updatedAt = new Date().toISOString();
    await upsertExpense(expense, user.accountId);
    return Response.json({ ok: true, imageFile: "" });
  }

  if (intent === "upload") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json({ error: "No image" }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const { filename, mime } = await saveImage(
      user.accountId,
      buffer,
      file.type,
      file.name || "pasted.png",
    );
    if (expense.imageFile) await deleteImage(user.accountId, expense.imageFile);
    expense.imageFile = filename;
    expense.imageMime = mime;
    expense.originalName = file.name || "pasted.png";
    expense.updatedAt = new Date().toISOString();
    // Rename to convention immediately if date+report already set.
    const renamed = await renameImageToConvention(
      user.accountId,
      expense.imageFile,
      expense.date,
      expense.report,
      expense.originalName,
      expense.imageMime,
    );
    expense.imageFile = renamed;
    await upsertExpense(expense, user.accountId);
    return Response.json({ ok: true, imageFile: renamed });
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
}
