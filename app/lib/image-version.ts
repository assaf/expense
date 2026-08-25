/**
 * Content version for an expense's stored receipt image.
 *
 * The version is the pair of fields that change whenever the bytes served at
 * `/expense/:id/image` change: replacing an image stores a new blob key and
 * bumps `updatedAt`, renaming changes `imageFile` (and the key). Unrelated
 * edits also bump `updatedAt`; that only causes a harmless extra thumbnail
 * fetch, never a stale one.
 *
 * Rendered into image URLs as `?v=…` so the URL is content-keyed: a changed
 * image means a changed URL, which lets the loader serve the response with a
 * year-long immutable cache. Browsers must not revalidate immutable
 * resources, so a replaced image can never be served stale from cache.
 * Shared by the list thumbnails, the editor, and the image loader (which
 * compares the rendered `v` against the current row to decide the TTL).
 */
export function imageVersion(expense: {
  updatedAt: string | Date;
  imageFile: string;
}): string {
  const updatedAt =
    expense.updatedAt instanceof Date
      ? expense.updatedAt.toISOString()
      : expense.updatedAt;
  return `${updatedAt}-${expense.imageFile}`;
}
