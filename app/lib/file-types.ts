/**
 * File-type detection for uploaded receipt files (images + PDFs). Shared by
 * the image routes, the OCR pipeline, and the inbound-email attachment
 * scoring, so each check lives in exactly one place.
 *
 * Each predicate takes whichever of mime / filename / bytes the caller has:
 *  - mime: tolerates parameters ("application/pdf; charset=…") via splitting
 *  - filename: case-insensitive extension match
 *  - bytes: PDF magic bytes, covering mislabeled uploads (e.g. a browser
 *    that reports no type)
 * Any provided signal may match — pass what you have.
 */

/** True when the mime type is a PDF (parameters after ";" ignored). */
function isPdfMime(mime: string): boolean {
  return mime.split(";")[0]!.trim().toLowerCase() === "application/pdf";
}

/** True when the filename ends in .pdf (case-insensitive). */
function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** True when the buffer starts with the PDF magic bytes ("%PDF-"). */
function isPdfMagicBytes(buffer: Buffer): boolean {
  return (
    buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-"
  );
}

/** True when the input is a PDF — by mime, filename, or magic bytes. */
export function isPdf(input: {
  buffer?: Buffer;
  mime?: string;
  originalName?: string;
}): boolean {
  if (input.mime !== undefined && isPdfMime(input.mime)) return true;
  if (input.originalName !== undefined && isPdfName(input.originalName)) {
    return true;
  }
  if (input.buffer !== undefined && isPdfMagicBytes(input.buffer)) return true;
  return false;
}

/** File extensions the app treats as image receipts. Single source of truth
 * for extension-based image detection — add a format here (not in a second
 * regex) when a new image type is supported. The storage mime map in
 * images.server.ts covers the narrower subset it re-encodes/stores by
 * mime; the wider set here is what detection accepts. */
const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "heic",
  "heif",
  "bmp",
  "tif",
  "tiff",
  "avif",
] as const;

const IMAGE_NAME_RE = new RegExp(`\\.(${IMAGE_EXTENSIONS.join("|")})$`, "i");

/** True when the input is an image — by mime or filename. */
export function isImage(input: {
  mime?: string;
  originalName?: string;
}): boolean {
  if (
    input.mime !== undefined &&
    input.mime.toLowerCase().startsWith("image/")
  ) {
    return true;
  }
  if (
    input.originalName !== undefined &&
    IMAGE_NAME_RE.test(input.originalName)
  ) {
    return true;
  }
  return false;
}

/** True when a dropped/pasted/uploaded file matches the upload input —
 * any image mime, or a PDF by mime or filename. Client-side counterpart
 * to the server's isImage/isPdf checks; used by the drag-drop targets. */
export function isReceiptFile(file: File): boolean {
  return (
    file.type.startsWith("image/") ||
    file.type === "application/pdf" ||
    isPdfName(file.name)
  );
}
