import { deleteImage, imageResponseHeaders } from "~/lib/images.server";
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
 * 160px thumbnails; those are precomputed at upload time and stored in the
 * `thumbnail` column so serving never touches sharp. Legacy images without a
 * thumbnail fall back to the full stored image instead of resizing on the
 * fly.
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const width = Number(url.searchParams.get("w"));
  const wantsTile = Number.isInteger(width) && width >= 16 && width <= 160;

  // The list view asks for the 160px thumbnail, which lives in its own
  // column: read without the BYTEA then (the tile is the hot path, and the
  // full image would otherwise leave Postgres only to be discarded). Any
  // other request needs the bytes, and a tile whose row has no thumbnail
  // (a legacy image) falls back to them below.
  const row = await readExpenseImage(params.id, user.accountId, {
    bytes: !wantsTile,
  });
  if (!row || row.type !== "receipt" || !row.imageFile) {
    return notFound();
  }

  // Validators: blob bytes are written once and never mutated in place; a
  // replacement gets a new key (and bumps updatedAt), a rename changes
  // imageFile. So a weak ETag from the expense row is enough to skip the
  // response body entirely on browser revalidation of unversioned URLs.
  const version = imageVersion(row);
  const etag = `W/"${version}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  // `v` is the content key rendered by the list thumbnails and the editor:
  // when it matches the current row, the URL can only ever serve these
  // bytes, so the browser may cache them for a year without revalidating.
  // Absent or mismatched `v` (legacy URLs, stale tabs) keeps the short TTLs
  // so those clients revalidate soon and pick up a replacement.
  const versioned = url.searchParams.get("v") === version;
  if (wantsTile && row.thumbnail) {
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

  // No thumbnail (or not a tile request): the full stored image. A tile
  // whose row predates thumbnails costs a second read here, which is the
  // one-off case the comment above has always described.
  const full = row.blobData
    ? row
    : await readExpenseImage(params.id, user.accountId);
  if (!full?.blobData) return notFound();
  return new Response(full.blobData as BodyInit, {
    headers: {
      ...imageResponseHeaders(
        full.blobMime || full.imageMime || "image/png",
        versioned
          ? "private, max-age=31536000, immutable"
          : "private, max-age=3600",
      ),
      ETag: etag,
    },
  });
}

/** Clear the stored receipt image (the editor's remove button). Image
 * replacements are drafts attached on Save (see saveExpenseFromForm). */
export async function action({ request, params }: Route.ActionArgs) {
  const { user, intent } = await requireIntent(request);
  const expense = await readExpense(params.id, user.accountId);
  if (!expense || expense.type !== "receipt") return notFound();

  if (intent === "delete") {
    if (expense.imageFile) await deleteImage(user.accountId, expense.imageFile);
    expense.imageFile = "";
    expense.imageMime = "";
    expense.originalName = "";
    expense.imageSha256 = "";
    expense.updatedAt = new Date().toISOString();
    await upsertExpense(expense, user.accountId);
    return Response.json({ ok: true, imageFile: "" });
  }

  return unknownIntent();
}
