import {
  deleteImage,
  imageResponseHeaders,
  renameImageToConvention,
} from "~/lib/images.server";
import { prepareUploadOr400 } from "~/lib/receipt-ocr.server";
import {
  readExpense,
  readExpenseImage,
  upsertExpense,
} from "~/lib/db/expenses";
import { imageVersion } from "~/lib/image-version";
import { unknownIntent } from "~/lib/validation";
import { notFound } from "~/lib/validation";
import { requireIntent } from "~/lib/route-helpers.server";
import { requireUser } from "~/lib/auth.server";
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
  // One round trip instead of two: the expense row and its image blob arrive
  // together (LEFT JOIN on the namespaced key). Blob fields are null when
  // the expense has no image or its blob row is missing — 404, same as a
  // null blob read.
  const row = await readExpenseImage(params.id, user.accountId);
  if (!row || row.type !== "receipt" || !row.imageFile || !row.blobData) {
    return notFound();
  }

  // Validators: blob bytes are written once and never mutated in place — a
  // replacement gets a new key (and bumps updatedAt), a rename changes
  // imageFile. So a weak ETag from the expense row is enough to skip the
  // response body entirely on browser revalidation of unversioned URLs.
  const version = imageVersion(row);
  const etag = `W/"${version}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const url = new URL(request.url);
  // `v` is the content key rendered by the list thumbnails and the editor:
  // when it matches the current row, the URL can only ever serve these
  // bytes, so the browser may cache them for a year without revalidating.
  // Absent or mismatched `v` (legacy URLs, stale tabs) keeps the short TTLs
  // so those clients revalidate soon and pick up a replacement.
  const versioned = url.searchParams.get("v") === version;
  const width = Number(url.searchParams.get("w"));
  // 160px is the list-view size — serve the precomputed thumbnail; legacy
  // images without one get the full stored image (zero CPU, just a bigger
  // payload for the one-off legacy row).
  if (Number.isInteger(width) && width >= 16 && width <= 160 && row.thumbnail) {
    return new Response(row.thumbnail as BodyInit, {
      headers: {
        ...imageResponseHeaders(
          "image/jpeg",
          versioned
            ? "private, max-age=31536000, immutable"
            : "private, max-age=86400, immutable",
        ),
        ETag: etag,
      },
    });
  }

  return new Response(row.blobData as BodyInit, {
    headers: {
      ...imageResponseHeaders(
        row.blobMime || row.imageMime || "image/png",
        versioned
          ? "private, max-age=31536000, immutable"
          : "private, max-age=3600",
      ),
      ETag: etag,
    },
  });
}

/** Replace or clear the receipt image without reloading the editor. */
export async function action({ request, params }: Route.ActionArgs) {
  const { user, form, intent } = await requireIntent(request);
  const expense = await readExpense(params.id, user.accountId);
  if (!expense || expense.type !== "receipt") return notFound();

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
    // PDFs are rasterized to PNG before storage: receipts are always
    // displayed as images, and the thumbnail/export pipelines assume the
    // stored bytes are decodable by sharp. Only an unreadable PDF fails.
    const saved = await prepareUploadOr400(
      form,
      user.accountId,
      "image-upload",
    );
    if (saved instanceof Response) return saved;
    if (expense.imageFile) await deleteImage(user.accountId, expense.imageFile);
    expense.imageFile = saved.filename;
    expense.imageMime = saved.mime;
    expense.originalName = saved.originalName;
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
    return Response.json({
      ok: true,
      imageFile: renamed,
      // The content version the client renders into its image URL — the
      // editor needs the new updatedAt (its loader isn't revalidated by the
      // action), or its `?v=` would keep the old value and the URL would
      // stay stale-cached.
      updatedAt: expense.updatedAt,
    });
  }

  return unknownIntent();
}
