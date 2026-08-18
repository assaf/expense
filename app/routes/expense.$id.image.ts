import {
  deleteImage,
  imageResponseHeaders,
  readImage,
  readUploadedFile,
  renameImageToConvention,
  saveImage,
} from "~/lib/images.server";
import { prepareUploadedReceipt } from "~/lib/receipt-ocr.server";
import { requireUser } from "~/lib/auth.server";
import { readExpense, upsertExpense } from "~/lib/db/expenses";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/expense.$id.image";

/**
 * Receipt image serving. The only hot path is the list view, which asks for
 * 160px thumbnails — those are precomputed at upload time and stored in the
 * `thumbnail` column so serving never touches sharp. Legacy images without a
 * thumbnail fall back to the full stored image instead of resizing on the
 * fly.
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const expense = await readExpense(params.id, user.accountId);
  if (!expense || expense.type !== "receipt" || !expense.imageFile) {
    return new Response("Not found", { status: 404 });
  }
  const image = await readImage(user.accountId, expense.imageFile);
  if (!image) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const width = Number(url.searchParams.get("w"));
  // 160px is the list-view size — serve the precomputed thumbnail when
  // available; legacy images without one get the full stored image (zero
  // CPU, just a bigger payload for the one-off legacy row).
  if (
    Number.isInteger(width) &&
    width >= 16 &&
    width <= 160 &&
    image.thumbnail
  ) {
    return new Response(image.thumbnail as BodyInit, {
      headers: imageResponseHeaders(
        "image/jpeg",
        "private, max-age=86400, immutable",
      ),
    });
  }

  return new Response(image.buffer as BodyInit, {
    headers: imageResponseHeaders(
      image.mime || expense.imageMime || "image/png",
      "private, max-age=3600",
    ),
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
    const uploaded = await readUploadedFile(form);
    if (!uploaded) {
      return Response.json({ error: "No image" }, { status: 400 });
    }
    // PDFs are rasterized to PNG before storage: receipts are always
    // displayed as images, and the thumbnail/export pipelines assume the
    // stored bytes are decodable by sharp. Only an unreadable PDF fails.
    const prepared = await prepareUploadedReceipt(uploaded, "image-upload");
    if (prepared === null) {
      return Response.json(
        { error: "Couldn't read that PDF." },
        { status: 400 },
      );
    }
    const { filename, mime: storedMime } = await saveImage(
      user.accountId,
      prepared.buffer,
      prepared.mime,
      prepared.originalName,
    );
    if (expense.imageFile) await deleteImage(user.accountId, expense.imageFile);
    expense.imageFile = filename;
    expense.imageMime = storedMime;
    expense.originalName = prepared.originalName;
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

  return unknownIntent();
}
