import { isPdf } from "~/lib/file-types";
import {
  deleteImage,
  readImage,
  readUploadedFile,
  renameImageToConvention,
  saveImage,
} from "~/lib/images.server";
import { resizeToJpeg, STORED_IMAGE_MAX_WIDTH } from "~/lib/image-normalize";
import { rasterizePdfUpload } from "~/lib/receipt-ocr.server";
import { requireUser } from "~/lib/auth.server";
import { readExpense, upsertExpense } from "~/lib/store.server";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/expense.$id.image";

/**
 * The list view renders 56px thumbnails per row — serving the full stored
 * image for each is wasteful, so the loader resizes on the fly when asked
 * (`?w=160`). Result is JPEG regardless of stored format; undecodable or
 * out-of-range params fall back to the full image. The cap matches the
 * storage normalizer (image-normalize.ts) so a thumbnail request can never
 * upscale beyond the stored resolution.
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
  if (
    Number.isInteger(width) &&
    width >= 16 &&
    width <= STORED_IMAGE_MAX_WIDTH
  ) {
    try {
      const thumb = await resizeToJpeg(image.buffer, {
        maxWidth: width,
        maxHeight: width,
        quality: 80,
      });
      return new Response(thumb as BodyInit, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "private, max-age=86400",
        },
      });
    } catch {
      // Fall through to the original bytes below.
    }
  }

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
    const uploaded = await readUploadedFile(form);
    if (!uploaded) {
      return Response.json({ error: "No image" }, { status: 400 });
    }
    const { buffer, mime, originalName } = uploaded;
    // PDFs are rasterized to PNG before storage: receipts are always
    // displayed as images, and the thumbnail/export pipelines assume the
    // stored bytes are decodable by sharp. Only an unreadable PDF fails.
    let saveBuffer = buffer;
    let saveMime = mime;
    let saveName = originalName;
    if (isPdf(uploaded)) {
      try {
        const pdf = await rasterizePdfUpload(uploaded);
        saveBuffer = pdf.buffer;
        saveMime = pdf.mime;
        saveName = pdf.originalName;
      } catch (err) {
        console.warn("[image-upload] PDF render failed:", err);
        return Response.json(
          { error: "Couldn't read that PDF." },
          { status: 400 },
        );
      }
    }
    const { filename, mime: storedMime } = await saveImage(
      user.accountId,
      saveBuffer,
      saveMime,
      saveName,
    );
    if (expense.imageFile) await deleteImage(user.accountId, expense.imageFile);
    expense.imageFile = filename;
    expense.imageMime = storedMime;
    expense.originalName = saveName;
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
